// OrchDesk 脑手解耦插件（T-P2-4）
//
// 主会话（CEO）负责理解 / 回收 / 沉淀；SubAgent（Worker）执行 / 反馈 / 即用即走。
// 会话中 SubAgent 以 inline 芯片呈现（W-xxx · 执行中 → 已回收并销毁）。
//
// 防漂移（ADR-0004 / T-P2-4）：
//   - Worker 必须即用即走，不要长驻（dispose 即销毁）。
//   - SubAgent 上下文销毁后不得有任何残留（Cordis isolate + meta.origin:'subagent'）。
//   - Worker 输出晋升主会话记忆须经 Director 过滤（FR-10 分层记忆），fail-closed。
//   - 芯片是 inline 呈现（数据模型在此，渲染由渲染层经桥消费，不占独立区域/弹窗）。
//
// 实现：Worker 生命周期映射到 dsh 原生 ctx.agents.create / AgentHandle.dispose（ADR-0004）。
// 真实 spawn/dispose 在 dsh 运行时执行；本骨架在类型与结构上就绪，运行期验证受 BUG-W02 门控。

import type { Context } from '@deepseek-ai/cordis';
import type { Agent, PreStepDecision, CreateAgentOptions, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { UserMessage, SessionId } from '@deepseek-ai/dsh-session';
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';

export const name = 'orchdesk-brain';
export const inject = ['agents'];

export interface BrainConfig {
  /** 每任务 SubAgent 并发上限（背压）。0 = 不限制。 */
  maxConcurrentSubagents: number;
  /** 上下文隔离开关（Cordis isolate）。 */
  isolationEnabled: boolean;
  /** Director 过滤用的模型（seam，默认空=走默认）。 */
  directorModel: string;
}

export const Config: z<BrainConfig> = z.object({
  maxConcurrentSubagents: z.number().default(3),
  isolationEnabled: z.boolean().default(true),
  directorModel: z.string().default(''),
});

export type SubAgentStatus = 'dispatched' | 'executing' | 'disposed';

export interface SubAgentRecord {
  /** 渲染层 inline 芯片 id，如 W-108。 */
  id: string;
  sessionId: SessionId;
  /** 芯片文案，如「临时任务」「开发总监」。 */
  label: string;
  status: SubAgentStatus;
  startedAt: number;
  finishedAt?: number;
  /** 成果（晋升主会话记忆前须经 Director 过滤）。 */
  result?: string;
  parentSession?: SessionId;
}

export interface SubAgentEvent {
  kind: 'dispatch' | 'dispose';
  record: SubAgentRecord;
}

export interface BrainHands {
  dispatchSubAgent(task: { label: string; prompt: string; ref?: string; parentSession?: SessionId }): Promise<SubAgentRecord>;
  disposeSubAgent(id: string, result?: string): Promise<void>;
  /** Worker 输出晋升主会话记忆须经 Director 批准；fail-closed。 */
  promoteWorkerOutput(output: string): Promise<{ approved: boolean; reason: string }>;
  listSubAgents(): SubAgentRecord[];
  /** 供桥/渲染层订阅 inline 芯片事件（不占独立区域/弹窗）。 */
  subscribe(cb: (e: SubAgentEvent) => void): () => void;
}

export function apply(ctx: Context, config: BrainConfig): void {
  const registry = new Map<string, SubAgentRecord>();
  const handles = new Map<string, AgentHandle>();
  const subscribers = new Set<(e: SubAgentEvent) => void>();
  let seq = 0;

  const emit = (e: SubAgentEvent): void => {
    for (const cb of subscribers) {
      try { cb(e); } catch { /* 订阅者异常不影响生命周期 */ }
    }
  };

  async function dispatchSubAgent(task: {
    label: string;
    prompt: string;
    ref?: string;
    parentSession?: SessionId;
  }): Promise<SubAgentRecord> {
    if (config.maxConcurrentSubagents > 0 && registry.size >= config.maxConcurrentSubagents) {
      throw new Error(`subagent concurrency cap reached (${config.maxConcurrentSubagents})`);
    }
    const id = `W-${++seq}`;
    const sessionId = brandSessionId(`orchdesk-sub-${id}-${Date.now()}`);
    const rec: SubAgentRecord = {
      id,
      sessionId,
      label: task.label,
      status: 'dispatched',
      startedAt: Date.now(),
      parentSession: task.parentSession,
    };
    registry.set(id, rec);
    try {
      // seam（ADR-0004）：Worker 作为子 Fiber，经 dsh 原生 ctx.agents.create 创建；
      // meta.origin:'subagent' + delegationDepth 确保 Cordis isolate 域隔离（上下文销毁即清）。
      const opts: CreateAgentOptions = {
        sessionId,
        meta: { origin: 'subagent', parentSession: task.parentSession, delegationDepth: 1 },
      };
      const handle = await ctx.agents.create(opts);
      handles.set(id, handle);
      rec.status = 'executing';
      emit({ kind: 'dispatch', record: { ...rec } });
      return { ...rec };
    } catch (err) {
      registry.delete(id);
      throw err;
    }
  }

  async function disposeSubAgent(id: string, result?: string): Promise<void> {
    const rec = registry.get(id);
    if (!rec) return;
    const handle = handles.get(id);
    if (handle) {
      // seam：dispose 停止 loop、await 退出、注销 agent、移除 session、解旋 scoped world
      // （即用即走，零残留）。
      await handle.dispose();
      handles.delete(id);
    }
    rec.status = 'disposed';
    rec.finishedAt = Date.now();
    rec.result = result;
    emit({ kind: 'dispose', record: { ...rec } });
    registry.delete(id); // 销毁即清，无残留（ADR-0004 isolate）
  }

  // Director 过滤：Worker 输出晋升主会话记忆须经 Director 批准（FR-10 / ADR-0004）。
  // fail-closed：默认拒绝，避免 Worker 直写全局记忆。真实实现调 Director 子 agent 评估（seam）。
  async function promoteWorkerOutput(_output: string): Promise<{ approved: boolean; reason: string }> {
    return { approved: false, reason: 'director-filter-pending' };
  }

  ctx.effect(() => {
    // 标记主/手角色（CEO vs Worker）：Worker（subagent origin）不污染主会话记忆。
    const offPreStep = ctx.on(
      'agent/pre-step',
      async (
        payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
        next: () => Promise<PreStepDecision>,
      ): Promise<PreStepDecision> => {
        void payload;
        return next();
      },
    );

    const api: BrainHands = {
      dispatchSubAgent,
      disposeSubAgent,
      promoteWorkerOutput,
      listSubAgents: () => [...registry.values()].map((r) => ({ ...r })),
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
    };
    // 暴露给桥/其它插件（运行时 seam：main.ts 经 dsh 控制通道调用，渲染层经桥订阅芯片事件）。
    // 若本版本 Cordis 不提供 provide，则退化为仅供同进程订阅（桥经 subscribe 拉取）。
    const anyCtx = ctx as unknown as { provide?: (n: string, v: unknown, b?: boolean) => void };
    anyCtx.provide?.('brainHands', api, true);

    return () => {
      offPreStep();
      for (const [id, handle] of handles) {
        try { void handle.dispose(); } catch { /* already disposed or unavailable */ }
      }
      registry.clear();
      handles.clear();
      subscribers.clear();
    };
  }, 'orchdesk-brain.lifecycle()');
}
