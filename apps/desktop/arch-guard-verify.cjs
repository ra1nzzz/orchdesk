/**
 * 架构守护测试（ADR-0010 · 借鉴 lencx/Minke 的 knownViolation 自检思路）。
 *
 * 动机：OrchDesk 有一批「只靠自觉」的架构铁律——渲染层禁 require、纯逻辑模块
 * 零 electron 依赖、工具执行与持久化只在主进程。这些约束过去只在人脑和 ADR 里，
 * 没有机器守护：改着改着就会被静默破坏，而且没人会在 review 里发现。
 *
 * 与功能测试的区别：功能测试断言「代码做了什么」，本套件断言「代码不允许变成
 * 什么样」。后者一旦失效是**静默**的——所以每条规则都必须配自检：
 *
 *   M1 规则必须命中自己的正样本（正则写错/被误改成永假 → FAIL「规则失效」）
 *   M2 规则的扫描面必须非空（glob 写错/文件改名 → FAIL「规则空转」）
 *   M3 豁免名单指向的文件必须存在（拼错路径 → FAIL「豁免失效」）
 *   M4 白名单模块必须存在
 *
 * 运行：node arch-guard-verify.cjs
 */
const path = require('path');
const fs = require('fs');

const APP_DIR = __dirname;
const ROOT = path.resolve(APP_DIR, '..', '..');

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ------------------------------ 扫描面 ------------------------------ */

/** 剥离块注释与整行 // 注释；不剥行尾注释，以免误伤 'http://' 之类的字符串。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function rendererFiles() {
  const dir = path.join(APP_DIR, 'renderer');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => ({ name: `renderer/${f}`, abs: path.join(dir, f) }));
}

/** 纯逻辑模块白名单：零 electron 依赖、可 node 直测（ADR-0008 / 渲染层双环境方案）。 */
const PURE_MODULES = [
  'agent-runtime.ts', 'browser-tools.ts', 'connector-registry.ts', 'credentials.ts', 'data-dir.ts',
  'memory-promotion.ts', 'memory-summarize.ts', 'plugin-market.ts',
  'sandbox-log.ts', 'session-events.ts', 'usage-registry.ts',
];
function pureFiles() {
  return PURE_MODULES.map((f) => ({ name: f, abs: path.join(APP_DIR, f) }));
}

function hostSourceFiles() {
  return [...PURE_MODULES.map((f) => path.join(APP_DIR, f)), ...rendererFiles().map((f) => f.abs)];
}

function read(p) { return fs.readFileSync(p, 'utf-8'); }

/* ------------------------------ 规则表 ------------------------------ */

/**
 * 每条规则：id / desc / files / forbid（正则数组）/ sample（必然违规的正样本）。
 * sample 用于 M1 自检：规则抓不到自己的 sample = 规则失效。
 */
const RULES = [
  {
    id: 'R1',
    desc: '渲染层禁 Node/Electron 直连（一律经 contextBridge）',
    files: rendererFiles,
    forbid: [
      /\brequire\s*\(/,
      /\bprocess\s*\./,
      /__dirname\b/,
      /__filename\b/,
      /from\s+['"]electron['"]/,
      /\bnode:/,
    ],
    sample: "const { app } = require('electron');\nconst p = process.cwd();\n",
  },
  {
    id: 'R2',
    desc: '纯逻辑模块零 electron 依赖（才可 node 直测）',
    files: pureFiles,
    forbid: [
      /from\s+['"]electron['"]/,
      /require\(\s*['"]electron['"]\s*\)/,
      /\bipcMain\b/,
      /\bipcRenderer\b/,
      /\bBrowserWindow\b/,
    ],
    sample: "import { app, ipcMain } from 'electron';\nexport const p = app.getPath('userData');\n",
  },
  {
    id: 'R3',
    desc: '纯逻辑模块不得依赖宿主层（main/preload/host-services）',
    files: pureFiles,
    forbid: [
      /from\s+['"]\.\/main['"]/,
      /from\s+['"]\.\/preload['"]/,
      /from\s+['"]\.\/host-services['"]/,
      /require\(\s*['"]\.\/main['"]\s*\)/,
    ],
    sample: "import { boot } from './main';\nexport const x = boot;\n",
  },
  {
    id: 'R4',
    desc: '渲染层不得做持久化与工具执行（只在主进程）',
    files: rendererFiles,
    forbid: [
      /\bfs\s*\.\s*(writeFileSync|appendFileSync|unlinkSync|rmSync|mkdirSync)\b/,
      /\bchild_process\b/,
      /\bexecSync\s*\(/,
      /\bspawnSync\s*\(/,
    ],
    sample: "const fs = require('fs');\nfs.writeFileSync('a.txt', 'x');\n",
  },
  {
    id: 'R5',
    desc: '源码禁硬编码本机绝对路径与密钥形态',
    files: () => hostSourceFiles().map((abs) => ({ name: path.basename(abs), abs })),
    forbid: [
      /[A-Za-z]:\\+Users\\+/i,
      /\/home\/[a-z][a-z0-9_-]*\//,
      /\bghp_[A-Za-z0-9]{20,}\b/,
      /\bsk-[A-Za-z0-9]{20,}\b/,
    ],
    sample: "const HOME = 'C:\\\\Users\\\\someone\\\\.orchdesk';\nconst TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz012345';\n",
  },
];

/** 对一段代码跑规则，返回命中列表（[{ rule, file, pattern, line }]）。 */
function scanRule(rule, code, fileName) {
  const hits = [];
  const lines = stripComments(code).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of rule.forbid) {
      if (re.test(line)) hits.push({ rule: rule.id, file: fileName, pattern: String(re), line: i + 1, text: line.trim().slice(0, 120) });
    }
  });
  return hits;
}

/* ------------------------------ 规则执行 ------------------------------ */

(async () => {
  console.log('== 架构守护：规则（ADR-0010）==');

  for (const rule of RULES) {
    await check(`${rule.id} ${rule.desc}`, () => {
      const files = rule.files();
      assert(files.length > 0, `${rule.id} 扫描面为空（规则空转）`);
      const hits = [];
      for (const f of files) {
        assert(fs.existsSync(f.abs), `${rule.id} 扫描到不存在的文件：${f.name}`);
        hits.push(...scanRule(rule, read(f.abs), f.name));
      }
      assert(hits.length === 0, `${rule.id} 命中 ${hits.length} 处违规：\n        ` +
        hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n        '));
    });
  }

  /* -------------------- 非正则规则：产物链路不陈旧 -------------------- */

  console.log('== 架构守护：产物链路 ==');

  await check('R6 插件产物链路不陈旧（src → lib → vendor；忘了 tsc/vendor 会假通过）', () => {
    const pkgDir = path.join(ROOT, 'packages', 'plugin');
    const plugins = fs.readdirSync(pkgDir).filter((d) => fs.statSync(path.join(pkgDir, d)).isDirectory());
    assert(plugins.length > 0, '未找到任何插件包（扫描面为空）');
    const problems = [];

    for (const name of plugins) {
      const srcDir = path.join(pkgDir, name, 'src');
      const libEntry = path.join(pkgDir, name, 'lib', 'index.js');
      const vendorEntry = path.join(APP_DIR, 'vendor', 'plugins', name, 'index.js');
      if (!fs.existsSync(libEntry)) { problems.push(`${name}: 缺 lib/index.js（需 tsc 编译）`); continue; }
      if (!fs.existsSync(vendorEntry)) { problems.push(`${name}: 缺 vendor 产物（需 node scripts/vendor-dsh.cjs）`); continue; }

      if (fs.existsSync(srcDir)) {
        const newestSrc = Math.max(...fs.readdirSync(srcDir)
          .filter((f) => f.endsWith('.ts'))
          .map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs));
        if (Number.isFinite(newestSrc) && newestSrc > fs.statSync(libEntry).mtimeMs) {
          problems.push(`${name}: src 比 lib 新（需 npx tsc -p packages/plugin/${name}/tsconfig.json）`);
        }
      }
      if (fs.statSync(libEntry).mtimeMs > fs.statSync(vendorEntry).mtimeMs) {
        problems.push(`${name}: lib 比 vendor 新（需 node scripts/vendor-dsh.cjs）`);
      }
    }
    assert(problems.length === 0, '产物链路陈旧：\n        ' + problems.join('\n        '));
  });

  await check('R7 每个验证套件都在 package.json verify 链上（防套件被悄悄摘掉）', () => {
    const pkg = JSON.parse(read(path.join(APP_DIR, 'package.json')));
    const chain = String(pkg.scripts && pkg.scripts.verify || '');
    assert(chain.length > 0, 'package.json 缺少 verify 脚本');
    const baseline = 18; // v0.12.0 基线（含本套件与 ts-loader 前的 18 个）
    const missing = [];
    for (const f of fs.readdirSync(APP_DIR)) {
      if (f.endsWith('-verify.cjs') && !chain.includes(f)) missing.push(`apps/desktop/${f}`);
    }
    assert(missing.length === 0, '以下套件不在 verify 链上：' + missing.join(', '));
    const count = (chain.match(/-verify\.cjs|verify-[a-z-]+\.mjs/g) || []).length;
    assert(count >= baseline, `verify 链上套件数 ${count} 少于基线 ${baseline}（链条被删减？）`);
  });

  /* -------------------- 元规则：防规则静默失效 -------------------- */

  console.log('== 架构守护：元规则自检（防规则失效）==');

  for (const rule of RULES) {
    await check(`M1 ${rule.id} 规则有效性自检（必须命中自己的正样本）`, () => {
      const hits = scanRule(rule, rule.sample, '<sample>');
      assert(hits.length > 0, `${rule.id} 抓不到自己的正样本——正则已失效，必须修规则或换样本`);
    });
  }

  await check('M2 全部规则扫描面非空（glob/清单写错 → 规则空转）', () => {
    const empty = RULES.filter((r) => r.files().length === 0).map((r) => r.id);
    assert(empty.length === 0, '扫描面为空的规则：' + empty.join(', '));
  });

  await check('M3 纯逻辑白名单模块均存在（改名/删除后需同步本清单）', () => {
    const missing = PURE_MODULES.filter((f) => !fs.existsSync(path.join(APP_DIR, f)));
    assert(missing.length === 0, '白名单中不存在的模块：' + missing.join(', '));
  });

  await check('M4 纯逻辑白名单确实零 electron（与 R2 交叉复核：清单本身没写多）', () => {
    const dirty = PURE_MODULES.filter((f) => /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(stripComments(read(path.join(APP_DIR, f)))));
    assert(dirty.length === 0, '白名单里含 electron 依赖（应从清单移除或改造为纯逻辑）：' + dirty.join(', '));
  });

  console.log(log.join('\n'));
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
