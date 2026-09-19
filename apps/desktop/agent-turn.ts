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
  executeTool: (tool: ToolCall, ctx?: { sessionId?: string }) => Promise<ToolResult>;
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

const toolRejectMemo = new Map<string, true>();
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
function abortedTurn(tools: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }>, steps: number): AgentTurnResult {
  return { text: '（已停止）', intent: 'CONFIRM', aborted: true, tools, steps };
}

export function abortAgentTurn(sessionId: string): { ok: boolean; reason?: string } {
  const cur = turnAborts.get(String(sessionId || ''));
  if (!cur) return { ok: false, reason: 'no-active-turn' };
  cur.abort();
  return { ok: true };
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
  const apiMessages: ApiMessage[] = sessionMsgs
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.text)
    .slice(-20)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.text as string }));
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
  const MAX_ITERATIONS = Math.max(1, Math.min(200, modelCfg.maxToolIterations || 20));
  const rejectKey = toolRejectKey(provider, model);
  let providerRejectsTools = toolRejectMemo.has(rejectKey);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal.aborted) return abortedTurn(toolSteps, stepCount);
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
      if (signal.aborted || isAbortError(err)) return abortedTurn(toolSteps, stepCount);
      return { text: `（模型调用失败）${(err as Error).message}`, intent: 'CONFIRM' };
    }
    if (reply.usage) {
      const u = reply.usage;
      turnUsage = turnUsage
        ? { p: turnUsage.p + u.promptTokens, c: turnUsage.c + u.completionTokens, t: turnUsage.t + u.totalTokens }
        : { p: u.promptTokens, c: u.completionTokens, t: u.totalTokens };
    }
    if (reply.toolsRejected) {
      providerRejectsTools = true;
      toolRejectMemo.set(rejectKey, true);
      console.warn(`[orchdesk] 提供商「${provider.name}」不接受工具定义，后续会话转为文本兜底解析。`);
    }

    if (reply.toolCalls.length) {
      const assistantMsg = buildAssistantToolCallMessage(reply.content, reply.toolCalls as NativeToolCall[]);
      apiMessages.push(assistantMsg);

      for (const tc of reply.toolCalls) {
        if (signal.aborted) return abortedTurn(toolSteps, stepCount);
        stepCount++;
        h.notifyToolStep(sessionId, tc.name, 'running');
        const result = await h.executeTool(tc, { sessionId });
        if (signal.aborted) return abortedTurn(toolSteps, stepCount);
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
      if (signal.aborted) return abortedTurn(toolSteps, stepCount);
      stepCount++;
      h.notifyToolStep(sessionId, tc.name, 'running');
      const result = await h.executeTool(tc, { sessionId });
      if (signal.aborted) return abortedTurn(toolSteps, stepCount);
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
  }

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
    { text: finalReply, tools: toolSteps, steps: stepCount, model },
    { file: eventFileFor(h.dataDir(), sessionId), context: { sessionId, turn: stepCount } },
  );

  return { text: finalReply, intent: 'ACT', tools: toolSteps, steps: stepCount };
  } finally {
    finishTurn(sessionId, ac);
  }
}
