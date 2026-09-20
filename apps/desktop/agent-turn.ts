/**
 * Agent 回合循环（模型 + 工具迭代 + 事件/用量双写）。
 * 不依赖 electron：窗口推送、会话存档、工具执行由宿主注入。
 */
import * as path from 'node:path';
import {
  TOOL_DEFS,
  type ApiMessage,
  type ModelReply,
  type NativeToolCall,
  type ToolCall,
  type ToolResult,
  buildAssistantToolCallMessage,
  buildSystemPrompt,
  buildToolResultMessage,
  extractToolCalls,
  isKnownTool,
  MAX_TOOL_ITERATIONS_CAP,
  MAX_TOOL_ITERATIONS_DEFAULT,
  normalizeHistory,
} from './agent-runtime';
import { DATA_FILE_NAMES } from './data-dir';
import { emitCanonicalEvent } from './event-emit';
import { firePreStep, getService } from './dsh-runtime';
import { log } from './logger';
import { callModel as callModelHttp, isAbortError, type ModelProviderLike } from './model-client';
import { appendEvents, eventFileFor, type SessionEvent } from './session-events';
import { appendUsageTurn, readUsageFile, writeUsageFile, type UsageEntry } from './usage-registry';

export type AgentTurnResult = {
  text: string;
  intent: string;
  tools?: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }>;
  steps?: number;
  aborted?: boolean;
};

export type AgentTurnProvider = ModelProviderLike & { id: string; models?: string[] };

export type AgentTurnHost = {
  loadModelConfig: () => {
    providers: AgentTurnProvider[];
    defaultModel?: string;
    maxToolIterations?: number;
  };
  getSession: (id: string) => { msgs?: Array<{ role?: string; text?: string } & Record<string, unknown>> } | undefined;
  ensureSession: (id: string) => void;
  saveStore: () => void;
  dataDir: () => string;
  sessionCwd: (sessionId?: string) => string;
  executeTool: (tool: ToolCall, ctx?: { sessionId?: string; signal?: AbortSignal }) => Promise<ToolResult>;
  notifyAgentDelta: (sessionId: string, text: string) => void;
  notifyToolStep: (sessionId: string, name: string, ph: 'running' | 'done' | 'error', result?: string) => void;
};

interface MemoryServiceLike {
  recall?(query: string, opts?: { domain?: string; k?: number }): unknown;
  listDomain?(domain: string): unknown;
}

interface PromptServiceLike {
  mergeForAgent?(agentId: string): unknown;
}

let host: AgentTurnHost | undefined;

export function initAgentTurn(deps: AgentTurnHost): void {
  host = deps;
}

function requireHost(): AgentTurnHost {
  if (!host) throw new Error('initAgentTurn 未调用');
  return host;
}

const toolRejectMemo = new Map<string, { t: number }>();
export function clearToolRejectMemo(providerId?: string): void {
  if (!providerId) { toolRejectMemo.clear(); return; }
  for (const k of [...toolRejectMemo.keys()]) if (k.startsWith(providerId + '|')) toolRejectMemo.delete(k);
}
function toolRejectKey(provider: AgentTurnProvider, model: string): string {
  return `${provider.id}|${model}`;
}

const turnAborts = new Map<string, AbortController>();
function beginTurn(sessionId: string): AbortController {
  const prev = turnAborts.get(sessionId);
  if (prev) prev.abort();
  const ac = new AbortController();
  turnAborts.set(sessionId, ac);
  return ac;
}
function finishTurn(sessionId: string, ac: AbortController): void {
  if (turnAborts.get(sessionId) === ac) turnAborts.delete(sessionId);
}

export function abortAgentTurn(sessionId: string): { ok: boolean; reason?: string } {
  const cur = turnAborts.get(String(sessionId || ''));
  if (!cur) return { ok: false, reason: 'no-active-turn' };
  cur.abort();
  return { ok: true };
}
/** 会话是否有进行中的回合（persist-sessions 合并策略用：进行中回合不被旧快照删掉）。 */
export function hasActiveTurn(sessionId: string): boolean {
  return turnAborts.has(String(sessionId || ''));
}

function nowTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export async function runAgentTurn(
  sessionId: string,
  text: string,
  opts: { models?: string[]; thinkLevel?: string },
): Promise<AgentTurnResult> {
  const h = requireHost();
  const modelCfg = h.loadModelConfig();
  if (!modelCfg.providers.length) return { text: '（未配置模型）请先在设置页「模型管理」中添加模型提供商。', intent: 'CONFIRM' };
  const ac = beginTurn(sessionId);
  const signal = ac.signal;
  try {
  const provider = modelCfg.providers[0]!;
  const availableModels = provider.models || [];
  const requested = (opts?.models || [])[0];
  const modelPick = availableModels.includes(requested || '') ? requested : (availableModels[0] || modelCfg.defaultModel);
  const model = modelPick || 'qwen3:14b';

  h.ensureSession(sessionId);

  void emitCanonicalEvent(
    'task.created',
    { type: 'user', id: text.slice(0, 64) },
    { type: 'Session', id: sessionId },
    { text, model },
    { file: eventFileFor(h.dataDir(), sessionId), context: { sessionId, turn: 0 } },
  );

  const sessionMsgs = h.getSession(sessionId)?.msgs || [];
  // B-1：渲染层 schema（r/x）与主进程 schema（role/text）双轨 → 读侧统一归一化，
  // 否则第二轮起历史全被过滤，Agent 处于「单轮失忆」状态。
  const apiMessages: ApiMessage[] = normalizeHistory(sessionMsgs as Parameters<typeof normalizeHistory>[0], 20);
  let memories: string[] = [];
  try {
    const memSvc = getService<MemoryServiceLike>('memory');
    if (memSvc?.recall) {
      const hits = (memSvc.recall(text, { k: 5 }) as Array<{ entry?: { text?: string }; score?: number }> | undefined) || [];
      memories = hits.filter((hit) => (hit.score ?? 0) > 0).map((hit) => String(hit.entry?.text || '')).filter(Boolean);
    }
    if (!memories.length && memSvc?.listDomain) {
      memories = ((memSvc.listDomain('global') as Array<{ text?: string }> | undefined) || [])
        .map((e) => String(e?.text || '')).filter(Boolean).slice(-10);
    }
  } catch { /* 记忆召回失败不阻塞回合 */ }

  let prompts: string[] = [];
  try {
    const promptSvc = getService<PromptServiceLike>('promptLib');
    if (promptSvc?.mergeForAgent) {
      const merged = promptSvc.mergeForAgent('orchdesk-main') as { sections?: Array<{ fromTitle?: string; body?: string; conflict?: boolean }> } | null;
      prompts = (merged?.sections || [])
        .map((s) => `【${s?.fromTitle || '提示词'}】${String(s?.body || '').trim()}${s?.conflict ? '（与其他提示词冲突，按用户最新意图取舍）' : ''}`)
        .filter((p) => p.length > 6);
    }
  } catch { /* 提示词合并失败不阻塞回合 */ }

  apiMessages.unshift({ role: 'system', content: buildSystemPrompt({ cwd: h.sessionCwd(sessionId), memories, prompts }) });
  apiMessages.push({ role: 'user', content: text });

  const toolSteps: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }> = [];
  let finalReply = '';
  let stepCount = 0;
  let turnUsage: { p: number; c: number; t: number } | null = null;
  // BUG 修复前 maxToolIterations 上限三处不一致（渲染层滑块 500 / 保存钳制 200 / 回合 200）：
  // 统一收敛到 agent-runtime 单源常量，所见即所得。
  const MAX_ITERATIONS = Math.max(1, Math.min(MAX_TOOL_ITERATIONS_CAP, modelCfg.maxToolIterations || MAX_TOOL_ITERATIONS_DEFAULT));
  const rejectKey = toolRejectKey(provider, model);
  // M-1：memo 带 TTL——一次误判（如模型合法空回复被当成「不吃工具」）不应把
  // 该模型在整个进程生命周期内永久打回文本兜底。10 分钟后自动重试原生协议。
  const rejectHit = toolRejectMemo.get(rejectKey);
  let providerRejectsTools = rejectHit ? Date.now() - rejectHit.t < 10 * 60 * 1000 : false;
  // 中止回合也走完整落盘/事件/记账（修复「已停止后消息在磁盘上无迹可查」）。
  let aborted = false;
  const bail = (): boolean => { if (!signal.aborted) return false; aborted = true; return true; };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (bail()) break;
    if (iter === 0) {
      let gate: { kind?: string; reason?: string } | null = null;
      try {
        gate = await firePreStep({
          sessionId, text,
          messages: apiMessages.map((m) => String(m.content || '')).filter(Boolean),
        });
      } catch (err) {
        log('WARN', 'intent', `pre-step waterfall 异常（放行）: ${(err as Error).message}`);
      }
      if (gate?.kind === 'reject') {
        finalReply = `（意图网关拦截）该请求被判定为高风险操作，已拒绝执行。${gate.reason ? `原因：${gate.reason}` : '可在设置页调整意图识别策略。'}`;
        break;
      }
    }
    const wantsTools = !providerRejectsTools;
    let reply: ModelReply;
    try {
      reply = await callModelHttp(provider, model, apiMessages, wantsTools ? TOOL_DEFS : [], {
        signal,
        onDelta: (chunk) => h.notifyAgentDelta(sessionId, chunk),
      });
    } catch (err) {
      if (bail()) break;
      // isAbortError 且非用户中止 = 120s requestSignal 超时：不是「已停止」，
      // 文案必须可区分（此前超时被 bail 之外的路径吞成「无总结」，原因丢失）。
      if (isAbortError(err)) {
        return { text: `（模型调用失败）请求超时或连接中断（120s）。可重试或降低输入长度。`, intent: 'CONFIRM' };
      }
      return { text: `（模型调用失败）${(err as Error).message}`, intent: 'CONFIRM' };
    }
    if (reply.usage) {
      const u = reply.usage;
      turnUsage = turnUsage
        ? { p: turnUsage.p + u.promptTokens, c: turnUsage.c + u.completionTokens, t: turnUsage.t + u.totalTokens }
        : { p: u.promptTokens, c: u.completionTokens, t: u.totalTokens };
    }
    // M-1：只有「明确指向工具协议」的拒绝才写跨会话 memo（带 TTL）；
    // 空 content / finish=length / 网关抖动 → 绝不毒化，只在本回合内兜底。
    if (reply.toolsRejected) {
      providerRejectsTools = true;
      toolRejectMemo.set(rejectKey, { t: Date.now() });
      console.warn(`[orchdesk] 提供商「${provider.name}」不接受工具定义，后续会话转为文本兜底解析（10 分钟后自动重试）。`);
    } else if (reply.softToolsFallback) {
      // 轮内软降级：本回合后续迭代不再带 tools（省无效重试），但不写 memo——
      // 下一会话仍会重新尝试原生协议（防一次误判永久失效）。
      providerRejectsTools = true;
      console.warn(`[orchdesk] 提供商「${provider.name}」带 tools 未产出内容，本回合转为文本兜底（不记录跨会话毒化）。`);
    }

    if (reply.toolCalls.length) {
      const assistantMsg = buildAssistantToolCallMessage(reply.content, reply.toolCalls as NativeToolCall[]);
      apiMessages.push(assistantMsg);

      for (const tc of reply.toolCalls) {
        if (bail()) break;
        stepCount++;
        h.notifyToolStep(sessionId, tc.name, 'running');
        const result = await h.executeTool(tc, { sessionId, signal });
        if (bail()) break;
        toolSteps.push({ n: tc.name, ph: result.error ? 'error' : 'done', result: result.error || result.result });
        h.notifyToolStep(sessionId, tc.name, result.error ? 'error' : 'done', result.error || result.result);
        void emitCanonicalEvent(
          'tool.result',
          { type: 'agent', id: sessionId },
          { type: 'ToolCall', id: tc.id || tc.name },
          { name: tc.name, result: result.result, error: result.error, sessionId },
          { file: eventFileFor(h.dataDir(), sessionId), context: { sessionId, step: stepCount } },
        );
        apiMessages.push(buildToolResultMessage(tc, result, 'native'));
      }
      if (aborted) break;
      continue;
    }

    const parsed = extractToolCalls(reply.content);
    const usable = parsed.calls.filter(c => isKnownTool(c.name));
    if (!usable.length) {
      finalReply = reply.content || reply.emptyReason || '（模型返回空内容）';
      break;
    }

    apiMessages.push({ role: 'assistant', content: parsed.stripped || `（调用工具：${usable.map(c => c.name).join(', ')}）` });
    for (const tc of usable) {
      if (bail()) break;
      stepCount++;
      h.notifyToolStep(sessionId, tc.name, 'running');
      const result = await h.executeTool(tc, { sessionId, signal });
      if (bail()) break;
      toolSteps.push({ n: tc.name, ph: result.error ? 'error' : 'done', result: result.error || result.result });
      h.notifyToolStep(sessionId, tc.name, result.error ? 'error' : 'done', result.error || result.result);
      void emitCanonicalEvent(
        'tool.result',
        { type: 'agent', id: sessionId },
        { type: 'ToolCall', id: tc.name },
        { name: tc.name, result: result.result, error: result.error, sessionId },
        { file: eventFileFor(h.dataDir(), sessionId), context: { sessionId, step: stepCount } },
      );
      apiMessages.push(buildToolResultMessage({ name: tc.name }, result, 'text'));
    }
    if (aborted) break;
  }

  if (aborted && !finalReply) finalReply = '（已停止）';

  if (!finalReply) finalReply = `（已完成 ${stepCount} 个工具步骤，但模型未给出最终总结）`;

  const s = h.getSession(sessionId) as Record<string, unknown> | undefined;
  const turnTs = Date.now();
  if (s) {
    const msgs = (s.msgs as Array<Record<string, unknown>>) || [];
    msgs.push({ role: 'user', text, t: nowTime(), ts: new Date(turnTs).toISOString() });
    msgs.push({
      role: 'assistant', text: finalReply, model, t: nowTime(), ts: new Date(turnTs).toISOString(),
      tools: toolSteps, steps: stepCount,
      ...(turnUsage ? { tok: { p: turnUsage.p, c: turnUsage.c } } : {}),
    });
    s.msgs = msgs;
    s.updated = new Date().toISOString();
    h.saveStore();
  }

  try {
    const evFile = eventFileFor(h.dataDir(), sessionId);
    const evs: Array<Omit<SessionEvent, 'seq'>> = [
      { ts: turnTs, kind: 'user', text },
      {
        ts: turnTs, kind: 'assistant', text: finalReply, model,
        tools: toolSteps.map((t) => ({ name: t.n, phase: t.ph, result: t.result })),
        ...(turnUsage ? { tok: { p: turnUsage.p, c: turnUsage.c } } : {}),
      },
    ];
    const w = appendEvents(evFile, evs);
    if (!w.ok) log('WARN', 'events', `会话事件追加失败: ${w.reason}`);
  } catch (err) {
    log('WARN', 'events', `会话事件双写异常: ${(err as Error).message}`);
  }

  if (turnUsage) {
    try {
      const entry: UsageEntry = {
        ts: new Date(turnTs).toISOString(),
        sessionId, provider: provider.name, model,
        promptTokens: turnUsage.p, completionTokens: turnUsage.c, totalTokens: turnUsage.t,
        steps: stepCount,
      };
      const usageFile = path.join(h.dataDir(), DATA_FILE_NAMES.usage);
      const cur = readUsageFile(usageFile);
      const next = appendUsageTurn(cur, entry);
      const wr = writeUsageFile(usageFile, next);
      if (!wr.ok) log('WARN', 'usage', `用量记账落盘失败: ${wr.reason}`);
    } catch (err) {
      log('WARN', 'usage', `用量记账异常: ${(err as Error).message}`);
    }
  }

  void emitCanonicalEvent(
    'task.completed',
    { type: 'agent', id: sessionId },
    { type: 'Session', id: sessionId },
    { text: finalReply, tools: toolSteps, steps: stepCount, model, ...(aborted ? { aborted: true } : {}) },
    { file: eventFileFor(h.dataDir(), sessionId), context: { sessionId, turn: stepCount } },
  );

  if (aborted) return { text: finalReply, intent: 'CONFIRM', aborted: true, tools: toolSteps, steps: stepCount };
  return { text: finalReply, intent: 'ACT', tools: toolSteps, steps: stepCount };
  } finally {
    finishTurn(sessionId, ac);
  }
}
