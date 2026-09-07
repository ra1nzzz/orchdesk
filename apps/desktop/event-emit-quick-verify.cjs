/**
 * Phase 8 Event Emission 快速验证（无需编译）
 *
 * 运行：node apps/desktop/event-emit-quick-verify.cjs
 *
 * 本脚本直接验证 event-emit.ts 的核心逻辑，不依赖 dist/ 产物。
 * 通过动态导入 TypeScript 源码实现。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  console.log('== Phase 8: Event Emission 快速验证 ==\n');

  // 使用 tsx 或 ts-node 加载 TS 模块
  let loadTs;
  try {
    const tsx = await import('tsx');
    loadTs = (f) => tsx.load(f);
  } catch {
    try {
      const tsnode = await import('ts-node');
      loadTs = (f) => tsnode.load(f);
    } catch {
      console.log('需要 tsx 或 ts-node 来加载 TypeScript 模块');
      console.log('安装：pnpm add -g tsx');
      process.exit(1);
    }
  }

  const appDir = __dirname;
  let eventEmit;
  try {
    eventEmit = await loadTs(path.join(appDir, 'event-emit.ts'));
  } catch (e) {
    console.error('加载 event-emit.ts 失败:', e.message);
    process.exit(1);
  }

  const { emitCanonicalEvent, setEnvelopeConsumer } = eventEmit;
  let passed = 0;
  let failed = 0;
  const log = [];

  async function check(name, fn) {
    try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
    catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e.message}`); }
  }

  function assert(cond, msg) { if (!cond) throw new Error(msg); }

  // 测试 A: emitCanonicalEvent 双写
  await check('emitCanonicalEvent 产出 CanonicalEnvelope 且字段完整', () => {
    let captured = null;
    setEnvelopeConsumer((env) => { captured = env; });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's1.ndjson');

    emitCanonicalEvent(
      'task.created',
      { type: 'user', id: 'user-1' },
      { type: 'Session', id: 's1' },
      { text: 'hello' },
      { file, context: { sessionId: 's1' } },
    );

    assert(captured !== null, 'consumer 应收到 envelope');
    assert(captured.id.length === 36, 'id 应为 UUID');
    assert(captured.type === 'task.created', 'type 应一致');
    assert(captured.actor.type === 'user', 'actor.type 应一致');
    assert(captured.subject.type === 'Session', 'subject.type 应一致');
    assert(captured.subject.id === 's1', 'subject.id 应一致');
    assert(captured.timestamp.startsWith('20'), 'timestamp 应为 ISO-8601');
    assert(captured.context.sessionId === 's1', 'context 应一致');
    assert(captured.payload.text === 'hello', 'payload 应一致');

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    assert(lines.length === 1, `应写入 1 行 SessionEvent，实际 ${lines.length}`);
    const se = JSON.parse(lines[0]);
    assert(se.kind === 'user', `SessionEvent.kind 应为 user，实际 ${se.kind}`);
    assert(se.text === 'hello', 'SessionEvent.text 应一致');
  });

  // 测试 B: fail-open
  await check('emitCanonicalEvent 无 consumer 时不抛错', () => {
    setEnvelopeConsumer(null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-ev-'));
    const file = path.join(dir, 's2.ndjson');
    emitCanonicalEvent('task.created', { type: 'user', id: 'u2' }, { type: 'Session', id: 's2' }, {}, { file });
    const content = fs.readFileSync(file, 'utf-8');
    assert(content.includes('"kind":"assistant"'), '本地双写仍应执行');
  });

  // 测试 C: consumer 替换
  await check('setEnvelopeConsumer 替换生效', () => {
    let first = '', second = '';
    setEnvelopeConsumer((e) => { first = e.id; });
    emitCanonicalEvent('t1', { type: 'user', id: 'u' }, { type: 'S', id: 's' }, {}, {});
    setEnvelopeConsumer((e) => { second = e.id; });
    emitCanonicalEvent('t2', { type: 'user', id: 'u' }, { type: 'S', id: 's' }, {}, {});
    assert(first !== second, '两次 consumer 应不同');
    assert(first.length === 36 && second.length === 36, '两次 id 都应为 UUID');
  });

  console.log(log.join('\n'));
  console.log(`\n== 结果：${passed} passed，${failed} failed ==`);
  if (failed > 0) process.exit(1);
})();
