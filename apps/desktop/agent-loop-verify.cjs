/**
 * Agent 回合管线集成验证（BUG-014 / BUG-013 端到端）
 * ----------------------------------------------------------------------------
 * 用 stub 顶替 electron 模块，直接 require 编译产物 dist/main.js，
 * 捕获 ipcMain handler 并驱动 runAgentTurn，配合可控的假模型网关验证：
 *
 *   1. native function calling：模型返回 tool_calls → 工具被执行 → 结果回传
 *   2. 工具结果使用 role:'tool' + tool_call_id（符合 OpenAI 规范）
 *   3. 文本兜底：模型不支持工具时返回 <tool:...> → 仍能解析执行
 *   4. 网关拒绝 tools（400）→ 自动降级重试，不抛错
 *   5. 数据落在统一目录（ORCHDESK_HOME），并从历史位置迁移
 *
 * 运行：node agent-loop-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// 1. 准备隔离的数据目录（ORCHDESK_HOME）+ 一个「历史位置」用于迁移验证
// ---------------------------------------------------------------------------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-home-'));
const LEGACY = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-legacy-'));
process.env.ORCHDESK_HOME = HOME;

// 历史位置预置一份会话 + 模型配置，验证启动迁移
fs.writeFileSync(
  path.join(LEGACY, 'orchdesk-sessions.json'),
  JSON.stringify({ 'legacy-sess': { id: 'legacy-sess', title: '历史会话', msgs: [{ role: 'user', text: '你好' }], updated: '2026-01-01T00:00:00.000Z' } }),
  'utf-8',
);
fs.writeFileSync(
  path.join(LEGACY, 'models.json'),
  JSON.stringify({ providers: [{ id: 'legacy-p', name: '历史提供商', type: 'ollama', baseUrl: 'http://127.0.0.1:1', models: ['legacy:1b'] }] }),
  'utf-8',
);

// ---------------------------------------------------------------------------
// 2. electron stub
// ---------------------------------------------------------------------------
const ipcHandlers = new Map();
const ipcListeners = new Map();

class FakeBrowserWindow {
  constructor() { this.webContents = { send: () => {} }; this.destroyed = false; }
  isDestroyed() { return this.destroyed; }
  once() {}
  loadFile() {}
  show() {}
  static getAllWindows() { return []; }
}

const electronStub = {
  app: {
    isPackaged: false,
    name: 'OrchDesk',
    getPath: (name) => (name === 'userData' ? LEGACY : path.join(os.tmpdir(), 'orchdesk-stub', name)),
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  ipcMain: {
    handle: (ch, fn) => { ipcHandlers.set(ch, fn); },
    on: (ch, fn) => { ipcListeners.set(ch, fn); },
  },
  BrowserWindow: FakeBrowserWindow,
  Tray: class { setToolTip() {} setContextMenu() {} },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createEmpty: () => ({}) },
  shell: { openPath: async () => '' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf-8'),
    decryptString: (b) => Buffer.from(b).toString('utf-8').replace(/^enc:/, ''),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// 3. 假模型网关：可编程应答
// ---------------------------------------------------------------------------
let scenario = [];       // 每次 fetch 返回一条应答
let requests = [];       // 记录所有请求，用于断言消息契约
let fetchError = null;

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body || '{}');
  requests.push({ url, body });
  if (fetchError) throw new Error(fetchError);
  const next = scenario.length > 1 ? scenario.shift() : scenario[0];
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(next),
    json: async () => next,
  };
};

/** OpenAI chat 应答构造器 */
const chatReply = (content, toolCalls) => ({ choices: [{ message: { content, tool_calls: toolCalls } }] });
const nativeFileList = () => [
  { id: 'call_1', type: 'function', function: { name: 'file_list', arguments: JSON.stringify({ path: HOME }) } },
];

// ---------------------------------------------------------------------------
// 4. 加载主进程
// ---------------------------------------------------------------------------
require('./dist/main.js');

let passed = 0;
let failed = 0;
const log = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    log.push(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`);
  }
}

(async () => {
  // 等 app.whenReady() 的 then 回调跑完（迁移 + loadStore）
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));

  console.log('\n== A. BUG-013 数据目录统一与迁移 ==');

  await check('启动后历史数据已迁移到 ORCHDESK_HOME', () => {
    assert.ok(fs.existsSync(path.join(HOME, 'orchdesk-sessions.json')), '会话文件应被迁移到统一目录');
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
    assert.ok(data['legacy-sess'], '历史会话应存在');
  });
  await check('历史模型配置已迁移（按 id 合并，不覆盖）', () => {
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'models.json'), 'utf-8'));
    assert.ok(data.providers.some((p) => p.id === 'legacy-p'), '历史提供商应被合并进来');
  });
  await check('会话文件落在统一数据目录而非 userData', () => {
    assert.ok(fs.existsSync(path.join(HOME, 'orchdesk-sessions.json')));
    assert.strictEqual(path.dirname(path.join(HOME, 'orchdesk-sessions.json')), HOME);
  });

  console.log('== B. BUG-014 原生 function calling ==');

  // 写入一个可用的模型配置
  fs.writeFileSync(path.join(HOME, 'models.json'), JSON.stringify({
    providers: [{ id: 'p1', name: '测试网关', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnc: Buffer.from('enc:test-key').toString('base64'), models: ['test-model'] }],
    defaultProvider: 'p1', defaultModel: 'test-model', maxToolIterations: 5,
  }), 'utf-8');

  const runAgentTurn = ipcHandlers.get('orchdesk:run-agent-turn');
  assert.ok(runAgentTurn, 'orchdesk:run-agent-turn handler 应已注册');

  // 场景 1：第一轮返回 tool_calls，第二轮返回最终文本
  requests = [];
  scenario = [chatReply('', nativeFileList()), chatReply('目录里有 2 个文件：a.txt、b.txt', undefined)];
  let out = await runAgentTurn(null, 's1', '列出目录内容', {});
  await check('工具被调用，最终拿到模型总结', () => {
    assert.strictEqual(out.intent, 'ACT');
    assert.ok(out.text.includes('a.txt'), '最终回复应包含模型总结: ' + out.text);
    assert.strictEqual(requests.length, 2, '应为「工具轮 + 总结轮」两次请求');
  });
  await check("第二轮请求里工具结果是 role:'tool'（不是 system）", () => {
    const msgs = requests[1].body.messages;
    const roles = msgs.map((m) => m.role);
    assert.ok(roles.includes('tool'), '应包含 role:tool，实际: ' + JSON.stringify(roles));
    assert.ok(!roles.slice(1).includes('system'), '除首条 system 外不应再插入 system 角色');
  });
  await check("tool 消息的 tool_call_id 与上一轮 assistant.tool_calls.id 匹配", () => {
    const msgs = requests[1].body.messages;
    const assistant = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.ok(assistant, '应存在带 tool_calls 的 assistant 消息');
    const ids = assistant.tool_calls.map((t) => t.id);
    const toolMsg = msgs.find((m) => m.role === 'tool');
    assert.ok(ids.includes(toolMsg.tool_call_id), `tool_call_id=${toolMsg.tool_call_id} 应匹配 ${JSON.stringify(ids)}`);
  });
  await check('请求携带了工具定义', () => {
    assert.ok(Array.isArray(requests[0].body.tools) && requests[0].body.tools.length === 5,
      '首轮应下发 5 个工具定义');
  });
  await check('会话已持久化（含工具步骤）', () => {
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
    const s = data['s1'];
    assert.ok(s, '会话 s1 应已落盘');
    const last = s.msgs[s.msgs.length - 1];
    assert.strictEqual(last.role, 'assistant');
    assert.ok(Array.isArray(last.tools) && last.tools.some((t) => t.n === 'file_list'), '应记录 file_list 工具步骤');
  });

  console.log('== C. 文本兜底解析 ==');

  requests = [];
  scenario = [
    chatReply('我先看看目录：\n<tool:file_list>{"path":"' + HOME.replace(/\\/g, '/') + '"}</tool>', undefined),
    chatReply('目录内容已读取完毕。', undefined),
  ];
  out = await runAgentTurn(null, 's2', '看看目录里有什么', {});
  await check('不支持 native tool_calls 时仍能解析 <tool:> 并执行', () => {
    assert.strictEqual(out.intent, 'ACT');
    assert.ok(out.text.includes('目录内容已读取完毕'), '实际: ' + out.text);
    assert.strictEqual(requests.length, 2, '应为两轮请求');
  });
  await check('文本兜底下工具结果用 user 角色（避免网关拒绝 role:tool）', () => {
    const msgs = requests[1].body.messages;
    const roles = msgs.map((m) => m.role);
    assert.ok(!roles.includes('tool'), '无 native tool_calls 时不应发 role:tool，实际: ' + JSON.stringify(roles));
    const resultMsg = msgs.find((m) => m.content && m.content.includes('[工具 file_list 执行结果]'));
    assert.ok(resultMsg, '应能找到工具结果消息');
    assert.strictEqual(resultMsg.role, 'user');
  });
  await check('工具参数被正确解析（旧实现把 args 塞进 input 导致执行失败）', () => {
    const data = JSON.parse(fs.readFileSync(path.join(HOME, 'orchdesk-sessions.json'), 'utf-8'));
    const tools = (data['s2'].msgs.at(-1).tools || []).filter((t) => t.n === 'file_list');
    assert.ok(tools.length > 0, 'file_list 应被执行过');
    assert.ok(!tools.some((t) => t.result && t.result.includes('路径不在允许范围内')),
      '参数解析错误会导致路径被拒，实际结果: ' + JSON.stringify(tools[0].result));
  });

  console.log('== D. 网关降级与错误处理 ==');

  requests = [];
  const originalFetch = global.fetch;
  let callNo = 0;
  global.fetch = async (url, opts) => {
    callNo++;
    if (callNo === 1) return { ok: false, status: 400, text: async () => 'unsupported parameter: tool_choice', json: async () => ({}) };
    return originalFetch(url, opts);
  };
  scenario = [chatReply('降级后正常回复', undefined)];
  out = await runAgentTurn(null, 's3', '测试降级', {});
  await check('网关拒绝 tool_choice(400) 时自动降级重试而非报错', () => {
    assert.ok(!out.text.includes('模型调用失败'), '实际: ' + out.text);
    assert.ok(out.text.includes('降级后正常回复'), '实际: ' + out.text);
  });
  global.fetch = originalFetch;

  requests = [];
  fetchError = 'connect ECONNREFUSED 127.0.0.1:9';
  out = await runAgentTurn(null, 's4', '测试网络错误', {});
  await check('网络错误被捕获并返回可读提示', () => {
    assert.ok(out.text.includes('模型调用失败'), '实际: ' + out.text);
    assert.strictEqual(out.intent, 'CONFIRM');
  });
  fetchError = null;

  console.log('== E. 未配置模型 ==');
  const backup = fs.readFileSync(path.join(HOME, 'models.json'), 'utf-8');
  fs.writeFileSync(path.join(HOME, 'models.json'), JSON.stringify({ providers: [] }), 'utf-8');
  out = await runAgentTurn(null, 's5', '你好', {});
  await check('无模型配置时提示用户去设置页', () => {
    assert.ok(out.text.includes('未配置模型'), '实际: ' + out.text);
  });
  fs.writeFileSync(path.join(HOME, 'models.json'), backup, 'utf-8');

  // -------------------------------------------------------------------------
  console.log('\n' + log.join('\n'));
  console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(LEGACY, { recursive: true, force: true }); } catch {}

  if (failed > 0) process.exit(1);
  console.log('Agent 回合管线全部验证通过');
  // 主进程内的 dsh 运行时持有定时器/句柄，需显式退出，否则进程挂起
  process.exit(0);
})();
