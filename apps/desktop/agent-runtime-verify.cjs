/**
 * Agent Runtime 单元验证（BUG-014 防回归）
 * ----------------------------------------------------------------------------
 * 直接 require 编译产物 dist/agent-runtime.js（纯逻辑、不依赖 electron），
 * 覆盖：
 *   1. parseToolArgs —— 参数宽容解析
 *   2. normalizeNativeToolCalls —— OpenAI / Ollama / 摊平 三种 tool_calls 形态
 *   3. extractToolCalls —— <tool:> / 未闭合 / tool_call 包裹 / 裸写法 / 纯 JSON / 普通文本
 *   4. buildAssistantToolCallMessage + buildToolResultMessage —— OpenAI 消息契约
 *   5. formatToolResult / truncateForModel —— 结果裁剪
 *   6. buildSystemPrompt —— 提示词覆盖全部工具
 *
 * 运行：node agent-runtime-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */

const assert = require('node:assert');
const rt = require('./dist/agent-runtime.js');

let passed = 0;
let failed = 0;
const log = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    log.push(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    log.push(`  FAIL  ${name}\n        ${(err && err.message) || err}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 1. parseToolArgs：参数宽容解析 ==');

check('JSON 字符串 → 对象', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_read', '{"path":"a.txt"}'), { path: 'a.txt' });
});
check('对象直接透传', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_read', { path: 'a.txt' }), { path: 'a.txt' });
});
check('代码围栏包裹的 JSON', () => {
  assert.deepStrictEqual(rt.parseToolArgs('shell_command', '```json\n{"command":"git status"}\n```'), { command: 'git status' });
});
check('混杂文本中抠出 JSON', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_list', '好的，我先看目录 {"path":"."} 然后继续'), { path: '.' });
});
check('裸字符串 → 映射到主参数（shell_command）', () => {
  assert.deepStrictEqual(rt.parseToolArgs('shell_command', 'git status'), { command: 'git status' });
});
check('裸字符串 → 映射到主参数（file_read）', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_read', 'C:/tmp/a.txt'), { path: 'C:/tmp/a.txt' });
});
check('空参数 → 空对象', () => {
  assert.deepStrictEqual(rt.parseToolArgs('file_list', ''), {});
  assert.deepStrictEqual(rt.parseToolArgs('file_list', null), {});
});
check('非法 JSON 且无主参数 → input 兜底', () => {
  assert.deepStrictEqual(rt.parseToolArgs('unknown_tool', 'abc'), { input: 'abc' });
});

// ---------------------------------------------------------------------------
console.log('== 2. normalizeNativeToolCalls：原生 tool_calls 归一化 ==');

check('OpenAI 形态（arguments 为 JSON 字符串）', () => {
  const out = rt.normalizeNativeToolCalls([
    { id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'call_1');
  assert.strictEqual(out[0].name, 'file_read');
  assert.deepStrictEqual(out[0].arguments, { path: 'a.txt' });
  assert.strictEqual(out[0].rawArguments, '{"path":"a.txt"}');
});
check('Ollama 形态（arguments 为对象、无 id）', () => {
  const out = rt.normalizeNativeToolCalls([
    { function: { name: 'shell_command', arguments: { command: 'git log' } } },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'shell_command');
  assert.deepStrictEqual(out[0].arguments, { command: 'git log' });
  assert.ok(out[0].id, '缺失 id 时应自动生成');
});
check('摊平形态（name/arguments 在顶层）', () => {
  const out = rt.normalizeNativeToolCalls([{ name: 'file_list', arguments: '{"path":"."}' }]);
  assert.strictEqual(out[0].name, 'file_list');
  assert.deepStrictEqual(out[0].arguments, { path: '.' });
});
check('多个工具调用全部保留（旧实现只取第一个）', () => {
  const out = rt.normalizeNativeToolCalls([
    { id: 'c1', function: { name: 'file_list', arguments: '{"path":"."}' } },
    { id: 'c2', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
  ]);
  assert.strictEqual(out.length, 2);
});
check('无 name 的条目被丢弃', () => {
  assert.strictEqual(rt.normalizeNativeToolCalls([{ id: 'x', function: {} }]).length, 0);
});
check('非数组输入 → 空数组', () => {
  assert.deepStrictEqual(rt.normalizeNativeToolCalls(undefined), []);
  assert.deepStrictEqual(rt.normalizeNativeToolCalls(null), []);
  assert.deepStrictEqual(rt.normalizeNativeToolCalls({}), []);
});

// ---------------------------------------------------------------------------
console.log('== 3. extractToolCalls：文本兜底解析 ==');

check('标准 <tool:name>json</tool>', () => {
  const r = rt.extractToolCalls('<tool:file_list>{"path":"."}</tool>');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'file_list');
  assert.deepStrictEqual(r.calls[0].arguments, { path: '.' });
  assert.strictEqual(r.stripped, '');
});
check('缺少闭合标签也能解析', () => {
  const r = rt.extractToolCalls('<tool:shell_command>{"command":"git status"}');
  assert.strictEqual(r.calls.length, 1);
  assert.deepStrictEqual(r.calls[0].arguments, { command: 'git status' });
});
check('正文 + 工具片段：剥离后保留正文', () => {
  const r = rt.extractToolCalls('我先看看目录：\n<tool:file_list>{"path":"."}</tool>\n然后读文件。');
  assert.strictEqual(r.calls.length, 1);
  assert.ok(r.stripped.includes('我先看看目录'), 'stripped 应保留正文: ' + JSON.stringify(r.stripped));
  assert.ok(!r.stripped.includes('<tool:'), 'stripped 不应残留工具标签');
});
check('一次多个工具调用', () => {
  const r = rt.extractToolCalls('<tool:file_list>{"path":"."}</tool><tool:file_read>{"path":"a.txt"}</tool>');
  assert.strictEqual(r.calls.length, 2);
});
check('重复调用去重', () => {
  const r = rt.extractToolCalls('<tool:file_list>{"path":"."}</tool><tool:file_list>{"path":"."}</tool>');
  assert.strictEqual(r.calls.length, 1);
});
check('tool:name;{...} 裸写法', () => {
  const r = rt.extractToolCalls('调用 tool:file_list;{"path":"."} 看看');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'file_list');
  assert.deepStrictEqual(r.calls[0].arguments, { path: '.' });
});
check('<tool_call>{...}</tool_call> 包裹写法', () => {
  const r = rt.extractToolCalls('<tool_call>{"name":"file_read","arguments":{"path":"a.txt"}}</tool_call>');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'file_read');
  assert.deepStrictEqual(r.calls[0].arguments, { path: 'a.txt' });
});
check('纯 JSON（name + arguments）', () => {
  const r = rt.extractToolCalls('{"name":"web_fetch","arguments":{"url":"https://a.com"}}');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'web_fetch');
});
check('普通文本不产生工具调用', () => {
  const r = rt.extractToolCalls('好的，我已经完成了任务，这是总结。');
  assert.strictEqual(r.calls.length, 0);
  assert.strictEqual(r.stripped, '好的，我已经完成了任务，这是总结。');
});
check('含 <tool 字样但无合法格式时不误判', () => {
  const r = rt.extractToolCalls('请告诉我 tool: 是什么');
  assert.strictEqual(r.calls.length, 0);
});
check('未知工具名可被 isKnownTool 识别并过滤', () => {
  const r = rt.extractToolCalls('<tool:rm_rf>{"path":"/"}</tool>');
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(rt.isKnownTool(r.calls[0].name), false);
  assert.strictEqual(rt.isKnownTool('file_read'), true);
});

// ---------------------------------------------------------------------------
console.log('== 4. OpenAI 消息契约 ==');

check("native 模式：assistant 消息带 tool_calls", () => {
  const calls = rt.normalizeNativeToolCalls([
    { id: 'call_1', function: { name: 'file_list', arguments: '{"path":"."}' } },
    { id: 'call_2', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
  ]);
  const msg = rt.buildAssistantToolCallMessage('先看目录', calls);
  assert.strictEqual(msg.role, 'assistant');
  assert.strictEqual(msg.tool_calls.length, 2);
  assert.strictEqual(msg.tool_calls[0].type, 'function');
  assert.strictEqual(msg.tool_calls[0].function.name, 'file_list');
  assert.strictEqual(msg.tool_calls[0].function.arguments, '{"path":"."}', 'arguments 必须原样回传');
});
check("native 模式：工具结果用 role:'tool' + tool_call_id", () => {
  const msg = rt.buildToolResultMessage({ id: 'call_1', name: 'file_list' }, { name: 'file_list', result: 'a.txt' }, 'native');
  assert.strictEqual(msg.role, 'tool', "必须用 role 'tool'，不能用 system/user");
  assert.strictEqual(msg.tool_call_id, 'call_1');
  assert.strictEqual(msg.name, 'file_list');
  assert.ok(msg.content.includes('a.txt'));
});
check("tool_call_id 与 assistant.tool_calls[].id 一一对应", () => {
  const calls = rt.normalizeNativeToolCalls([
    { id: 'c1', function: { name: 'file_list', arguments: '{"path":"."}' } },
    { id: 'c2', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
  ]);
  const assistant = rt.buildAssistantToolCallMessage('', calls);
  const ids = assistant.tool_calls.map((t) => t.id);
  for (const c of calls) {
    const toolMsg = rt.buildToolResultMessage(c, { name: c.name, result: 'ok' }, 'native');
    assert.ok(ids.includes(toolMsg.tool_call_id), `tool_call_id ${toolMsg.tool_call_id} 必须能在 assistant.tool_calls 中找到`);
  }
});
check("text 兜底模式：工具结果用 role:'user'（无 tool_calls 时 role:'tool' 非法）", () => {
  const msg = rt.buildToolResultMessage({ name: 'file_list' }, { name: 'file_list', result: 'a.txt' }, 'text');
  assert.strictEqual(msg.role, 'user');
  assert.strictEqual(msg.tool_call_id, undefined);
});
check("工具报错时结果文本标注失败", () => {
  const msg = rt.buildToolResultMessage({ id: 'c1', name: 'shell_command' }, { name: 'shell_command', result: '', error: '命令不在白名单' }, 'native');
  assert.ok(msg.content.includes('执行失败'));
  assert.ok(msg.content.includes('命令不在白名单'));
});

// ---------------------------------------------------------------------------
console.log('== 5. 结果裁剪 ==');

check('超长结果被截断并标注', () => {
  const long = 'x'.repeat(rt.TOOL_RESULT_FEEDBACK_LIMIT + 500);
  const out = rt.truncateForModel(long);
  assert.ok(out.length < long.length);
  assert.ok(out.includes('已截断'));
});
check('短结果原样返回', () => {
  assert.strictEqual(rt.truncateForModel('hello'), 'hello');
});
check('空结果有占位文本', () => {
  assert.ok(rt.formatToolResult('file_read', { name: 'file_read', result: '' }).includes('空结果'));
});

// ---------------------------------------------------------------------------
console.log('== 6. 系统提示词 ==');

check('提示词覆盖全部 5 个工具', () => {
  const p = rt.buildSystemPrompt();
  for (const n of rt.TOOL_NAMES) assert.ok(p.includes(n), `提示词缺少工具 ${n}`);
});
check('提示词给出 <tool:> 兜底格式示例', () => {
  const p = rt.buildSystemPrompt();
  assert.ok(p.includes('<tool:'), '应包含兜底格式说明');
  assert.ok(p.includes('function calling'), '应优先引导原生 function calling');
});

// ---------------------------------------------------------------------------
console.log('\n' + log.join('\n'));
console.log(`\n结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);

if (failed > 0) process.exit(1);
console.log('Agent Runtime 全部验证通过');
