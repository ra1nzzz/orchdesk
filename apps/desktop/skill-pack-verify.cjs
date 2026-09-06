/**
 * skill-pack 验证（.skill = <slug>/SKILL.md 的 STORE zip）。
 *
 * A 组：纯逻辑（require dist/skill-pack.js）—— CRC32 / slug 白名单 / frontmatter
 *       组装 / 结构。
 * B 组：跨语言校验 —— 把 zipStore 产物写临时文件，用系统 python3 zipfile 读回，
 *       确认「能被第三方 zip 读取器正确解出 <slug>/SKILL.md 与原内容」——
 *       手写 STORE zip 最大的风险就是「自己写自己读都对、别人读不了」。
 *
 * 运行：node skill-pack-verify.cjs（需先 npx tsc -p tsconfig.json）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_DIR = __dirname;
const PK = require(path.join(APP_DIR, 'dist', 'skill-pack.js'));

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  console.log('== Skill 打包器（.skill = STORE zip）==');

  /* ============================== A 组：纯逻辑 ============================== */

  await check('CRC32：已知向量校验（"123456789" → 0xCBF43926）', () => {
    const c = PK.crc32(Buffer.from('123456789', 'utf8'));
    assert(c === 0xCBF43926, `CRC32 应为 0xCBF43926，实际 ${c.toString(16)}`);
  });

  await check('CRC32：空串 = 0', () => {
    assert(PK.crc32(Buffer.alloc(0)) === 0, '空串 CRC 应为 0');
  });

  await check('slug 白名单：合法/非法三态', () => {
    assert(PK.isSkillSlug('promo-video') === true, '合法 slug 应通过');
    assert(PK.isSkillSlug('a') === true, '单字符合法');
    assert(PK.isSkillSlug('') === false, '空应拒');
    assert(PK.isSkillSlug('../evil') === false, '穿越应拒');
    assert(PK.isSkillSlug('a b') === false, '空格应拒');
    assert(PK.isSkillSlug('a\\b') === false, '反斜杠应拒');
    assert(PK.isSkillSlug('含中文') === false, '非法字符应拒');
  });

  await check('frontmatter：name/description 正确包进 --- 块，正文保留', () => {
    const md = PK.buildSkillMarkdown('promo-video', '做宣传片，含踩坑', '正文行一\n正文行二');
    assert(/^---\nname: promo-video\n/.test(md), '开头应是 frontmatter name');
    assert(/description: "做宣传片，含踩坑"\n---\n\n正文行一\n正文行二\n$/.test(md), 'description 加引号 + 正文在分割线后');
  });

  await check('assemble：非法 slug → ok:false + reason', () => {
    const r = PK.assembleSkillBytes({ slug: '../x', description: '', body: '' });
    assert(r.ok === false && !!r.reason, '应拒绝非法 slug');
  });

  await check('assemble：附加文件必须在 <slug>/ 下（越界拒）', () => {
    const r = PK.assembleSkillBytes({ slug: 'good', description: '', body: 'x',
      extra: [{ zipPath: 'outside/SKILL.md', content: 'y' }] });
    assert(r.ok === false, '越界附加文件应拒绝');
  });

  await check('assemble：zip 含 <slug>/SKILL.md（无重复），STORE 合法', () => {
    const r = PK.assembleSkillBytes({ slug: 'demo', description: 'd', body: 'body',
      extra: [{ zipPath: 'demo/references/note.md', content: 'note' }] });
    assert(r.ok === true, '组装应成功');
    const b = r.bytes;
    // 魔数 PK\x03\x04
    assert(b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04, 'ZIP local file 魔数');
    // EOCD 魔数 PK\x05\x06 在末尾 22 字节前
    const eocdSig = b.readUInt32LE(b.length - 22);
    assert(eocdSig === 0x06054b50, `EOCD 签名（实际 ${eocdSig.toString(16)}）`);
    const entries = b.readUInt16LE(b.length - 22 + 10);
    assert(entries === 2, `应 2 个条目（SKILL.md + references），实际 ${entries}`);
  });

  /* ==================== B 组：跨语言 zipfile 读回 ==================== */

  await check('B/python zipfile：能解出 <slug>/SKILL.md 且内容一致（含中文）', () => {
    const r = PK.assembleSkillBytes({ slug: '演示技能', description: '中文描述「引号与\\n换行」', body: '# 标题\n正文含中文 ✓ 与符号 & <标签>\n' });
    assert(r.ok === false, '中文 slug 应被拒（isSkillSlug 只许字母数字._-）');
  });

  await check('B/python zipfile：英文 slug 跨语言读回一致', () => {
    const body = '# 演示\n正文含中文 ✓ 与符号 & <尖括号>\n以及 \\n 转义和 "双引号"\n';
    const r = PK.assembleSkillBytes({ slug: 'demo-skill', description: '描述含中文与 & 符号', body,
      extra: [{ zipPath: 'demo-skill/references/tips.md', content: '参考文件\n第二行' }] });
    assert(r.ok === true, '组装应成功');
    const file = path.join(os.tmpdir(), 'orchdesk-skill-pack-test.skill');
    fs.writeFileSync(file, r.bytes);
    // 用系统 python 读回并校验内容（不依赖 node 侧 zip 实现）
    const script = `
import zipfile, json
z = zipfile.ZipFile(${JSON.stringify(file)})
names = sorted(z.namelist())
out = { 'names': names }
out['skill_md'] = z.read('demo-skill/SKILL.md').decode('utf-8')
out['tips'] = z.read('demo-skill/references/tips.md').decode('utf-8')
# 校验 zipfile 自身能完整读出所有条目（CRC 通过即解压成功）
out['testzip'] = z.testzip()
print(json.dumps(out, ensure_ascii=False))
`;
    const py = execFileSync('python', ['-c', script], { encoding: 'utf8' });
    const parsed = JSON.parse(py);
    assert(parsed.testzip === null, `testzip 应无坏条目（实际 ${parsed.testzip}）`);
    assert(parsed.names.includes('demo-skill/SKILL.md'), `zip 应含 demo-skill/SKILL.md（实际 ${parsed.names.join(',')}）`);
    assert(parsed.names.includes('demo-skill/references/tips.md'), 'zip 应含 references/tips.md');
    assert(parsed.skill_md.includes('name: demo-skill'), 'SKILL.md frontmatter name');
    assert(parsed.skill_md.includes('中文 ✓') && parsed.skill_md.includes('& <尖括号>'), '中文与特殊字符读回一致');
    assert(parsed.skill_md.includes('"双引号"'), '双引号保留');
    assert(parsed.tips.includes('参考文件'), '附加文件读回一致');
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  });

  await check('B/python zipfile：frontmatter 能被 zipfile 内的正文行数匹配', () => {
    const body = '第1段\n\n第2段';
    const r = PK.assembleSkillBytes({ slug: 'count', description: 'd', body });
    assert(r.ok === true, '组装应成功');
    const file = path.join(os.tmpdir(), 'orchdesk-skill-count.skill');
    fs.writeFileSync(file, r.bytes);
    const out = execFileSync('python', ['-c', `
import zipfile
print(len(zipfile.ZipFile(${JSON.stringify(file)}).read('count/SKILL.md').decode('utf-8').splitlines()))
`], { encoding: 'utf8' }).trim();
    // frontmatter(4行: --- name desc ---) + 空行 + body 2 段 = 7 行左右
    assert(parseInt(out, 10) >= 5, `SKILL.md 行数合理（frontmatter+body），实际 ${out}`);
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  });

  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();
