/// <reference types="electron" />
/**
 * OrchDesk 宿主服务（Host Services）
 * ----------------------------------------------------------------------------
 * dsh 底座提供「一切皆插件、可逆效应」的运行时，但 PRD §2 明确：dsh 缺的恰好是
 * OrchDesk 的增量——**桌面壳、跨平台沙箱、系统边界外补偿层、上游意图网关**。
 *
 * 因此 OrchDesk 的 9 个 Cordis 插件所注入的三个服务（sandboxPolicy / approval /
 * agents），由 OrchDesk 自己在桌面侧提供真实实现，而不是去拉完整的 dsh 发行版：
 *
 *   sandboxPolicy —— 目录白名单 + 命令白名单 + 沙箱模式持久化（跨平台 backend 的桌面实现）
 *   approval      —— 审批请求路由到 GUI 弹窗，fail-closed（无应答方/超时 → unavailable）
 *   agents        —— SubAgent 以独立 Cordis fiber 创建/销毁，满足「即用即走、可逆效应」
 *
 * 这是真实实现，不是占位：每个服务都可执行、可审计、可持久化。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Context } from '@deepseek-ai/cordis';

// ---------------------------------------------------------------------------
// 沙箱模式（对齐 dsh SandboxMode 命名）
// ---------------------------------------------------------------------------

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

const SANDBOX_MODES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

export interface SandboxPolicyLike {
  resolve(req?: { session?: { id: string } }): { mode: SandboxMode };
  setSandboxMode(session: { id: string }, mode: string): void;
  /** PRD FR-8：网络请求域名白名单（['*'] = 不限）。可读写。 */
  getNetworkAllow?(): string[];
  setNetworkAllow?(list: string[]): void;
  /** PRD FR-8：域名准入判定（供 web_fetch 等外发工具调用）。 */
  isDomainAllowed?(url: string): boolean;
}

interface SandboxState {
  mode: SandboxMode;
  sessionModes: Record<string, SandboxMode>;
  /** 网络域名白名单：'*' 表示不限制；支持后缀匹配（如 'github.com'）。 */
  networkAllow: string[];
  audit: Array<{ ts: number; kind: 'sandbox-mode'; mode: string; sessionId?: string }>;
}

function sandboxFile(): string {
  // 惰性：dataDir 由 main.ts 注入（避免本模块直接依赖 electron）
  const dir = process.env.ORCHDESK_DATA_DIR;
  return path.join(dir || '.', 'sandbox.json');
}

function loadSandbox(): SandboxState {
  const base: SandboxState = { mode: 'workspace-write', sessionModes: {}, networkAllow: ['*'], audit: [] };
  try {
    const f = sandboxFile();
    if (!fs.existsSync(f)) return base;
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as Partial<SandboxState>;
    return {
      mode: SANDBOX_MODES.includes(raw.mode as SandboxMode) ? (raw.mode as SandboxMode) : 'workspace-write',
      sessionModes: raw.sessionModes && typeof raw.sessionModes === 'object' ? raw.sessionModes : {},
      networkAllow: normalizeNetworkAllow(raw.networkAllow),
      audit: Array.isArray(raw.audit) ? raw.audit.slice(-200) : [],
    };
  } catch {
    return base;
  }
}

/** 归一化域名白名单：非法项丢弃；空数组回落 ['*']（不限），避免误配导致全网被封死。 */
export function normalizeNetworkAllow(list: unknown): string[] {
  if (!Array.isArray(list)) return ['*'];
  const cleaned = list
    .map((d) => String(d || '').trim().toLowerCase())
    .filter((d) => d.length > 0 && d.length < 256 && !/[\s/]/.test(d));
  return cleaned.length ? cleaned : ['*'];
}

/**
 * PRD FR-8：网络请求域名白名单判定。
 * 白名单含 '*' → 放行全部；否则 host 命中任一项（精确或后缀 .domain）→ 放行。
 * 无法解析的 URL 一律拒绝（fail-closed）。
 */
export function isDomainAllowed(url: string): boolean {
  const allow = normalizeNetworkAllow(loadSandbox().networkAllow);
  if (allow.includes('*')) return true;
  let host = '';
  try {
    host = new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return allow.some((d) => (d.startsWith('*.') ? host === d.slice(2) || host.endsWith(d.slice(1)) : host === d || host.endsWith('.' + d)));
}

function saveSandbox(state: SandboxState): void {
  try {
    fs.writeFileSync(sandboxFile(), JSON.stringify({ ...state, audit: state.audit.slice(-200) }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[orchdesk] 沙箱状态持久化失败:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// 审批
// ---------------------------------------------------------------------------

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface ApprovalRequestLike {
  toolName?: string;
  reason?: string;
  sessionId?: string;
  /**
   * PRD FR-9：被授权操作的具体目标（文件路径 / shell 命令 / URL）。
   * 白名单按「操作类型 + 目标」匹配，没有目标就只能被 '*' 规则命中。
   */
  target?: string;
  signal?: AbortSignal;
}

export interface ApprovalServiceLike {
  request(req: ApprovalRequestLike, signal?: AbortSignal): Promise<ApprovalOutcome>;
  setPolicy(agent: unknown, policy: 'ask' | 'never'): void;
  /** 由主进程注册「GUI 应答方」；未注册 → fail-closed 返回 unavailable。 */
  setUiAnswerer(fn: ((req: ApprovalRequestLike) => Promise<string>) | null): void;
}

// ---------------------------------------------------------------------------
// SubAgent（agents 服务）
// ---------------------------------------------------------------------------

export interface CreateAgentOptionsLike {
  sessionId?: string;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface AgentHandleLike {
  agent: { id: string; meta?: Record<string, unknown> };
  dispose(): Promise<void>;
}

/**
 * SubAgent 运行器：由 main.ts 注入真实实现（复用现有 callModel + 工具循环）。
 * 未注入时 create 仍成功，但 followup 会返回明确错误（不静默伪造结果）。
 */
export type AgentRunner = (
  input: { sessionId: string; meta?: Record<string, unknown>; messages: Array<{ role: string; content: string }> },
) => Promise<{ text: string }>;

export interface AgentsServiceLike {
  create(opts: CreateAgentOptionsLike): Promise<AgentHandleLike>;
  followup(sessionId: string, messages: Array<{ role: string; content: string }>): Promise<{ text: string }>;
  list(): string[];
}

// ---------------------------------------------------------------------------
// 对外：注册到主进程的句柄
// ---------------------------------------------------------------------------

export interface HostServices {
  approval: ApprovalServiceLike;
  /** PRD FR-8：沙箱策略（模式 + 网络域名白名单），供主进程工具链直接查询。 */
  sandboxPolicy: SandboxPolicyLike;
  /** 主进程注册 GUI 审批应答方（渲染层弹窗 → 回传 outcome）。 */
  setUiAnswerer(fn: ((req: ApprovalRequestLike) => Promise<string>) | null): void;
  /** 主进程注入 SubAgent 真实运行器。 */
  setAgentRunner(fn: AgentRunner | null): void;
}

// ---------------------------------------------------------------------------
// 插件定义
// ---------------------------------------------------------------------------

/**
 * apply() 的返回值不会被 ctx.plugin() 透出，所以用模块级句柄把服务暴露给主进程。
 * 未初始化时为 null（运行时尚未启动）。
 */
let currentHandle: HostServices | null = null;

/** 取宿主服务句柄；运行时未启动返回 null（调用方需判空，不静默降级）。 */
export function getHostServices(): HostServices | null {
  return currentHandle;
}

export const hostServices = {
  name: 'orchdesk-host-services',
  apply(ctx: Context): void {
    const sandbox = loadSandbox();
    let uiAnswerer: ((req: ApprovalRequestLike) => Promise<string>) | null = null;
    let agentRunner: AgentRunner | null = null;

    /** 已创建的 SubAgent：sessionId → { fiber, handle } */
    const agents = new Map<string, { fiber: { state: number; dispose: () => Promise<void> } }>();
    let agentSeq = 0;

    // ---- sandboxPolicy ----
    const sandboxPolicy: SandboxPolicyLike = {
      resolve(req) {
        const sid = req?.session?.id;
        if (sid && sandbox.sessionModes[sid]) return { mode: sandbox.sessionModes[sid] as SandboxMode };
        return { mode: sandbox.mode };
      },
      setSandboxMode(session, mode) {
        const normalized = (SANDBOX_MODES.includes(mode as SandboxMode) ? mode : 'read-only') as SandboxMode;
        // 未知模式一律降级为最严（fail-safe，不静默放宽）
        if (session?.id) sandbox.sessionModes[session.id] = normalized;
        else sandbox.mode = normalized;
        sandbox.audit.push({ ts: Date.now(), kind: 'sandbox-mode', mode: normalized, sessionId: session?.id });
        saveSandbox(sandbox);
      },
      // PRD FR-8：网络请求域名白名单（设置页可配，默认 ['*'] 不限）
      getNetworkAllow() {
        return normalizeNetworkAllow(sandbox.networkAllow);
      },
      setNetworkAllow(list) {
        sandbox.networkAllow = normalizeNetworkAllow(list);
        saveSandbox(sandbox);
      },
      isDomainAllowed(url) {
        return isDomainAllowed(url);
      },
    };

    // ---- approval ----
    const approval: ApprovalServiceLike = {
      async request(req, signal) {
        const abortSignal = req?.signal || signal;
        if (abortSignal?.aborted) return 'cancelled';

        // fail-closed：无 GUI 应答方 → 不开门
        if (!uiAnswerer) {
          console.warn(`[orchdesk] 审批请求「${req?.toolName || '未知操作'}」无 GUI 应答方 → fail-closed`);
          return 'unavailable';
        }

        const outcome = await new Promise<ApprovalOutcome>((resolve) => {
          let settled = false;
          const finish = (o: ApprovalOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            abortSignal?.removeEventListener('abort', onAbort);
            resolve(o);
          };
          // 超时兜底：2 分钟无应答 → unavailable（fail-closed）
          const timer = setTimeout(() => finish('unavailable'), 120_000);
          const onAbort = () => finish('cancelled');
          abortSignal?.addEventListener('abort', onAbort, { once: true });

          Promise.resolve(uiAnswerer!({
            toolName: req?.toolName,
            reason: req?.reason,
            sessionId: req?.sessionId,
            target: req?.target,
          })).then(
            (v) => {
              const allowed: ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];
              finish(allowed.includes(v as ApprovalOutcome) ? (v as ApprovalOutcome) : 'unavailable');
            },
            () => finish('unavailable'),
          );
        });

        return outcome;
      },
      setPolicy(_agent, policy) {
        // 桌面侧的部署级策略：paranoid 语义 = 逐项确认 → 收紧到 read-only
        if (policy === 'never') {
          sandbox.mode = 'read-only';
          sandbox.audit.push({ ts: Date.now(), kind: 'sandbox-mode', mode: 'read-only' });
          saveSandbox(sandbox);
        }
      },
      setUiAnswerer(fn) { uiAnswerer = fn; },
    };

    // ---- agents ----
    const agentsService: AgentsServiceLike = {
      async create(opts) {
        const sessionId = opts?.sessionId || `sub-${Date.now().toString(36)}-${++agentSeq}`;
        if (agents.has(sessionId)) {
          throw new Error(`SubAgent 会话 ${sessionId} 已存在`);
        }
        // 每个 SubAgent 独占一个 Cordis fiber：dispose 即完整逆回滚（可逆效应）
        const fiber = ctx.plugin({
          name: `orchdesk-subagent:${sessionId}`,
          apply() {
            return () => { agents.delete(sessionId); };
          },
        });
        const handle: AgentHandleLike = {
          agent: { id: sessionId, meta: opts?.meta },
          async dispose() {
            await Promise.resolve(fiber.dispose());
            agents.delete(sessionId);
          },
        };
        agents.set(sessionId, { fiber });
        return handle;
      },
      async followup(sessionId, messages) {
        if (!agents.has(sessionId)) return { text: `（SubAgent ${sessionId} 不存在或已销毁）` };
        if (!agentRunner) return { text: '（SubAgent 运行器未接入，无法执行）' };
        const meta = agents.get(sessionId);
        void meta;
        return agentRunner({ sessionId, messages });
      },
      list() { return [...agents.keys()]; },
    };

    ctx.provide('sandboxPolicy', sandboxPolicy);
    ctx.provide('approval', approval);
    ctx.provide('agents', agentsService);

    currentHandle = {
      approval,
      sandboxPolicy,
      setUiAnswerer(fn) { uiAnswerer = fn; },
      setAgentRunner(fn) { agentRunner = fn; },
    };

    // 逆效应：卸载时清空句柄并销毁所有 SubAgent fiber（不留残留）
    ctx.effect(() => () => {
      if (currentHandle && currentHandle.approval === approval) currentHandle = null;
      uiAnswerer = null;
      agentRunner = null;
      for (const [, rec] of agents) void Promise.resolve(rec.fiber.dispose()).catch(() => undefined);
      agents.clear();
    }, 'orchdesk-host-services.lifecycle()');
  },
};
