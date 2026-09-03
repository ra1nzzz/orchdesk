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
//
// 消费入口现状（②半接线梳理，2026-09）：桌面端「专家团编排」走 multi 插件的
// composeTeam（同用 ctx.agents.create，task 真实经 ctx.agents.followup 下发执行）；
// 本插件的 dispatchSubAgent / disposeSubAgent 是 T-P2-4 的脑手解耦 API seam，当前无
// 独立 UI/编排调用它（语义被 composeTeam 覆盖），但被 orchestration verify 完整测试
// （派生/状态机/即用即走/晋升门控）。保留作独立触发 SubAgent 的预留入口，勿当死代码删。

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

/**
 * Director 过滤回调（FR-10 worker→director 晋升 seam）。
 * 返回 true 放行；false / 非真 / 抛错 / 超时一律拒绝（fail-closed）。
 */
export type DirectorFilter = (output: string) => boolean | Promise<boolean>;

/**
 * 模块级 director 过滤 seam；null = 默认拒绝（fail-closed）。
 * 经 setDirectorFilter 注入，或在 apply 时从 config.directorFilter / ctx.directorFilter 读取。
 */
let directorFilter: DirectorFilter | null = null;

/** 注入 Director 过滤回调（FR-10 晋升 seam）；传 null 恢复默认拒绝。 */
export function setDirectorFilter(fn: DirectorFilter | null): void {
  directorFilter = fn;
}

/** Director 过滤默认超时（fail-closed：超时即拒绝）。 */
const DIRECTOR_FILTER_TIMEOUT_MS = 5_000;

/**
 * Worker 结果入 worker 域的截断上限。
 * Worker 输出可能很长（整段代码 / 大段日志），全量入记忆会挤爆向量语料。
 * 截断只影响记忆条目，不影响 disposeSubAgent 事件里的 rec.result（完整保留）。
 */
const WORKER_RESULT_MAX = 4_000;

/** 给 promise 加超时；超时即 reject（调用方转为拒绝）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('director-filter-timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

/**
 * 取记忆服务（可选依赖）。
 *
 * 必须用 ctx.get 而非属性访问：Cordis Context 是代理，在 fiber ctx 上访问
 * **未提供给该作用域**的服务属性会抛错；safeGet 会把这个错吞成 undefined，
 * 表现出来就是「memory 插件明明装载了却拿不到」。ctx.get 对缺失服务返回
 * undefined 且不抛错，是官方的取服务方式。
 */
function memoryServiceOf(ctx: Context):
  | { record?: (d: string, t: string, s: { origin: string; agent?: string; sessionId?: string }) => unknown }
  | undefined {
  const getter = safeGet(ctx, 'get');
  if (typeof getter === 'function') {
    try {
      return (getter as (n: string) => unknown).call(ctx, 'memory') as
        | { record?: (d: string, t: string, s: { origin: string; agent?: string; sessionId?: string }) => unknown }
        | undefined;
    } catch {
      return undefined;
    }
  }
  return safeGet(ctx, 'memory') as
    | { record?: (d: string, t: string, s: { origin: string; agent?: string; sessionId?: string }) => unknown }
    | undefined;
}

/** 安全读取属性（Cordis Context 代理对未知服务属性访问会抛错）。 */
function safeGet(obj: unknown, key: string): unknown {
  if (!obj) return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

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
  promoteWorkerOutput(output: string, opts?: { timeoutMs?: number }): Promise<{ approved: boolean; reason: string }>;
  /** 注入 / 移除 Director 过滤回调（放行门）。传 null 恢复 fail-closed 默认拒绝。 */
  setFilter(fn: DirectorFilter | null): void;
  listSubAgents(): SubAgentRecord[];
  /** 供桥/渲染层订阅 inline 芯片事件（不占独立区域/弹窗）。 */
  subscribe(cb: (e: SubAgentEvent) => void): () => void;
}

export function apply(ctx: Context, config: BrainConfig): void {
  // director 过滤 seam（FR-10）：可经 config.directorFilter / ctx.directorFilter 注入，
  // 或经模块级 setDirectorFilter 注入；均未提供时保持 fail-closed 默认拒绝。
  // 注意：Cordis Context 是代理，访问未提供服务属性会抛错 → 必须安全读取。
  const cfgFilter = safeGet(config, 'directorFilter');
  const ctxFilter = safeGet(ctx, 'directorFilter');
  if (typeof cfgFilter === 'function') directorFilter = cfgFilter as DirectorFilter;
  else if (typeof ctxFilter === 'function') directorFilter = ctxFilter as DirectorFilter;

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
    // FR-10 分层记忆的**源头**：Worker 输出先落 worker 域。
    // 不落这一步，worker 域永远是空的 —— promote 链路写得再完整也是无米下锅
    // （此前 brain 声明了 memory.commit 能力却从未落地，Worker 结果随 dispose 一起蒸发）。
    // 注意：这里只是「留下结果」，不是「晋升」——晋升到上层必须过 Director 过滤（见 promoteWorkerOutput）。
    commitWorkerResult(rec, result);
    emit({ kind: 'dispose', record: { ...rec } });
    registry.delete(id); // 销毁即清，无残留（ADR-0004 isolate）
  }

  /** 把 Worker 结果写入 worker 域（memory 插件可选依赖，缺失时静默跳过）。 */
  function commitWorkerResult(rec: SubAgentRecord, result?: string): void {
    if (!result || !result.trim()) return;
    try {
      // 必须用 ctx.get 而不是直接属性访问：Cordis Context 是代理，fiber ctx 上
      // 访问**未提供给该作用域**的服务属性会抛错（safeGet 会把这个错吞成 undefined，
      // 看起来就像「memory 插件没装载」）。ctx.get 对缺失服务返回 undefined，不抛错。
      const mem = memoryServiceOf(ctx);
      if (!mem || typeof mem.record !== 'function') return;
      mem.record('worker', result.slice(0, WORKER_RESULT_MAX), {
        origin: `subagent:${rec.id}`,
        agent: String(rec.label || rec.id),
        sessionId: String(rec.sessionId || ''),
      });
    } catch {
      // 记忆写入失败绝不影响 dispose 语义：Worker 即用即走优先，
      // 宁可丢一条记忆也不能让 dispose 抛错把 agent 泄漏在注册表里。
    }
  }

  // Director 过滤：Worker 输出晋升主会话记忆须经 Director 批准（FR-10 / ADR-0004）。
  // fail-closed：默认拒绝（无回调即拒），避免 Worker 直写全局记忆；有回调时：
  // 放行→晋升；回调抛错 / 超时 / 返回非真→拒绝。真实实现可调 Director 子 agent 评估。
  async function promoteWorkerOutput(
    output: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ approved: boolean; reason: string }> {
    const filter = directorFilter;
    if (!filter) return { approved: false, reason: 'director-filter-pending' };
    try {
      const allowed = await withTimeout(
        Promise.resolve(filter(output)),
        opts?.timeoutMs ?? DIRECTOR_FILTER_TIMEOUT_MS,
      );
      if (allowed === true) return { approved: true, reason: 'director-approved' };
      return { approved: false, reason: 'director-rejected' };
    } catch (e) {
      return {
        approved: false,
        reason: `director-filter-error:${e instanceof Error ? e.message : String(e)}`,
      };
    }
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
      // 放行门注入 seam：运行时（main.ts）据产品语义注入（如「用户即 Director」时放行，
      // 未来可换 LLM 裁决门）。不提供时保持模块级 fail-closed 默认拒绝。
      setFilter: (fn) => { setDirectorFilter(fn); },
      listSubAgents: () => [...registry.values()].map((r) => ({ ...r })),
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
    };
    // 暴露给桥/其它插件（运行时 seam：main.ts 经 dsh 控制通道调用，渲染层经桥订阅芯片事件）。
    // 若本版本 Cordis 不提供 provide，则退化为仅供同进程订阅（桥经 subscribe 拉取）。
    const anyCtx = ctx as unknown as { provide?: (n: string, v: unknown, b?: boolean) => void };
    anyCtx.provide?.('brainHands', api);

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
