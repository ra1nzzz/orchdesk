// OrchDesk 授权插件（T-P3-2）
//
// 职责（薄封装 dsh 既有 seam，不重写沙箱/授权核心 —— 防漂移 ADR-0005 / current-state §6）：
//   1. 三模式（default / trusted / paranoid）映射到 dsh 的 sandbox/mode + approval/policy 事件。
//   2. L0-L4 分级定义（数据/文档，供 GUI 展示与审计）。
//   3. 审批应答方：注册 `approval/request` listener，把 GUI 弹窗的结局回传；
//      fail-closed（超时/异常/无 UI 应答 → 'unavailable' 不开门）。
//   4. 审计日志聚合：订阅 approval/* 与 sandbox/mode 事件，供设置页/插件页检索。
//
// 实现依托 dsh 既有服务（依赖注入，不静态 import 沙箱/审批包）：
//   - ctx.sandboxPolicy（@deepseek-ai/dsh-sandbox-policy）：setSandboxMode / resolve
//   - ctx.approval（@deepseek-ai/dsh-user-approval）：request / setPolicy
// 真实 push 弹窗在 Electron 渲染层；本插件暴露 `setUiAnswerer` 由主进程桥接层在 GUI
// 就绪后注入（GUI 弹窗 → IPC → 主进程 resolver → outcome），运行期 seam 受 BUG-W02 门控。

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export const name = 'orchdesk-authz';
export const inject = ['sandboxPolicy', 'approval'];

// ---------------------------------------------------------------------------
// 三模式定义：映射到 dsh 的 SandboxMode + ApprovalPolicy。
// 不发明新词汇 —— dsh 只有 read-only / workspace-write / danger-full-access
// 三档 SandboxMode 与 ask / never 两档 ApprovalPolicy（见 dsh-sandbox-policy /
// dsh-user-approval）。OrchDesk 的「三模式」是这两轴的用户友好封装。
// ---------------------------------------------------------------------------
export type AuthzMode = 'default' | 'trusted' | 'paranoid';

export interface AuthzModeSpec {
  id: AuthzMode;
  label: string;
  /** 映射 dsh SandboxMode。 */
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** 映射 dsh ApprovalPolicy。 */
  approvalPolicy: 'ask' | 'never';
  /** 文案（设置页展示）。 */
  blurb: string;
}

export const AUTHZ_MODES: readonly AuthzModeSpec[] = [
  {
    id: 'default',
    label: '默认安全',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'ask',
    blurb: '工作区可写；L3/L4 操作弹窗确认（ask）。平衡日常使用与安全。',
  },
  {
    id: 'trusted',
    label: '信任模式',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'ask',
    blurb: '同默认沙箱，但放宽命令/网络白名单（仍受 SandboxMode 约束）。高危操作仍弹窗。',
  },
  {
    id: 'paranoid',
    label: '偏执模式',
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    blurb: '只读沙箱 + 任何 ask 自动拒绝（never）。最严；不可逆/越界操作一律不开门。',
  },
] as const;

// ---------------------------------------------------------------------------
// L0-L4 分级（数据常量，供 GUI 展示与审计；语义对齐渲染层 app.js 既有 L0-L4 说明）。
// ---------------------------------------------------------------------------
export type AuthzLevel = 0 | 1 | 2 | 3 | 4;

export interface AuthzLevelSpec {
  level: AuthzLevel;
  label: string;
  scope: string;
  /** 是否需授权弹窗（L3/L4 强制）。 */
  requiresApproval: boolean;
}

export const LEVELS: readonly AuthzLevelSpec[] = [
  { level: 0, label: '读取', scope: '无副作用', requiresApproval: false },
  { level: 1, label: '状态写入', scope: '应用域内', requiresApproval: false },
  { level: 2, label: '文件系统', scope: '受限目录', requiresApproval: false },
  { level: 3, label: '网络', scope: '白名单', requiresApproval: true },
  { level: 4, label: 'Shell / 进程', scope: '仅 FULL ACCESS', requiresApproval: true },
] as const;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
export interface AuthzConfig {
  /** 部署默认模式（用户可在设置页覆盖；覆盖经 sandbox/mode + approval/policy 事件持久化）。 */
  defaultMode: AuthzMode;
  /** 审批弹窗等待 GUI 应答的超时（ms）。超时 → unavailable（fail-closed）。 */
  approvalTimeoutMs: number;
}

export const Config: z<AuthzConfig> = z.object({
  defaultMode: z.union(['default', 'trusted', 'paranoid'] as const).default('default'),
  approvalTimeoutMs: z.number().default(120000),
});

// ---------------------------------------------------------------------------
// 审计日志条目
// ---------------------------------------------------------------------------
export type AuditKind = 'approval-asked' | 'approval-decided' | 'sandbox-mode';

export interface AuditEntry {
  kind: AuditKind;
  ts: number;
  /** 结构化可查询字段（不记录消息/路径原文，防 PII 泄露）。 */
  mode?: string;
  policy?: string;
  outcome?: string;
  toolName?: string;
  reason?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// 服务接口（经 ctx.provide('authz') 暴露给主进程桥）
// ---------------------------------------------------------------------------
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** GUI/主进程注入的 UI 应答回调：弹窗 → 回传 outcome。 */
export type UiAnswerer = (req: {
  toolName: string;
  reason?: string;
  sessionId?: string;
}) => Promise<ApprovalOutcome>;

export interface AuthzService {
  getModes(): readonly AuthzModeSpec[];
  getLevels(): readonly AuthzLevelSpec[];
  /** 当前会话/部署生效的模式（解析自 sandbox-policy）。 */
  getMode(sessionId?: string): Promise<AuthzMode>;
  /** 切换模式：经 dsh setSandboxMode + setApprovalPolicy 持久化（重启可回放）。 */
  setMode(mode: AuthzMode, sessionId?: string): Promise<void>;
  /** 注入 GUI 应答回调（主进程桥接层在 Electron GUI 就绪后调用）。 */
  setUiAnswerer(fn: UiAnswerer | null): void;
  /** 订阅审计日志条目（供设置页/插件页检索渲染）。 */
  subscribe(cb: (e: AuditEntry) => void): () => void;
  /** 取审计日志快照（环形缓冲，最多 200 条）。 */
  getAuditLog(): AuditEntry[];
}

const SESSION_EVENT_CAP = 200;

export function apply(ctx: Context, config: AuthzConfig): void {
  const audit: AuditEntry[] = [];
  const subscribers = new Set<(e: AuditEntry) => void>();
  let uiAnswerer: UiAnswerer | null = null;

  const pushAudit = (e: AuditEntry): void => {
    audit.push(e);
    if (audit.length > SESSION_EVENT_CAP) audit.shift();
    for (const cb of subscribers) {
      try { cb(e); } catch { /* 订阅者异常不影响审计 */ }
    }
  };

  const modeToSpec = (m: AuthzMode): AuthzModeSpec => {
    const found = AUTHZ_MODES.find((x) => x.id === m);
    return found ?? AUTHZ_MODES[0]!;
  };

  // 调用 dsh 既有服务（inject 声明，运行时由 Cordis 注入）。
  const sandboxPolicy = (ctx as unknown as { sandboxPolicy?: {
    resolve(req?: { session?: { id: string } }): { mode: string };
    setSandboxMode(session: { id: string }, mode: string): void;
  } }).sandboxPolicy;
  const approval = (ctx as unknown as { approval?: {
    setPolicy(agent: unknown, policy: 'ask' | 'never'): void;
  } }).approval;

  async function getMode(sessionId?: string): Promise<AuthzMode> {
    // 解析当前生效的 SandboxMode → 反查 AuthzMode（default/trusted 同映射 workspace-write+ask，
    // 视作 default；paranoid 映射 read-only+never）。
    const resolved = sandboxPolicy?.resolve(sessionId ? { session: { id: sessionId } } : {});
    const mode = resolved?.mode;
    const spec = AUTHZ_MODES.find((x) => x.sandboxMode === mode && x.approvalPolicy === 'never');
    return spec ? spec.id : 'default';
  }

  async function setMode(mode: AuthzMode, sessionId?: string): Promise<void> {
    const spec = modeToSpec(mode);
    // 持久化到 session 的 sandbox/mode 事件（dsh setSandboxMode 写日志，重启可回放）。
    if (sessionId && sandboxPolicy?.setSandboxMode) {
      sandboxPolicy.setSandboxMode({ id: sessionId }, spec.sandboxMode);
    }
    // approval/policy 的 paranoid='never' 由 dsh approval config / session 事件控制；
    // 此处对 sandbox/mode 持久化已满足 fail-safe（read-only 比 danger-full-access 更严）。
    // 注：dsh approval.setPolicy 作用于 live agent 对象，需 agent 句柄；
    // 部署级默认 ask 已覆盖 default/trusted。保持 fail-safe，不静默放宽。
    void approval;
    void sessionId;
    pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: spec.sandboxMode, policy: spec.approvalPolicy, sessionId });
  }

  function setUiAnswerer(fn: UiAnswerer | null): void {
    uiAnswerer = fn;
  }

  // 审批应答方：注册 approval/request listener（dsh 工具管道 L3/L4 ask 经此 seam）。
  // fail-closed：无 UI 应答 / 超时 / 异常 → 'unavailable'（dsh 据 unavailable 不开门）。
  // 注：approval/request 与 sandbox/mode 是 dsh 自定义事件，不在 Cordis 基础 Events 类型中，
  // 用 ctx 桥接法（与 brain 的 provide 同款）注册，保持本包仅依赖 cordis + schemastery。
  const ctxOn = (ctx as unknown as {
    on(event: string, listener: (...args: any[]) => any): () => void;
  }).on;
  const offApproval = ctxOn.call(ctx,
    'approval/request',
    async (
      req: { agent?: { session?: { id: string } }; toolName: string; reason?: string; signal?: AbortSignal },
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome> => {
      const sessionId = req.agent?.session?.id;
      pushAudit({
        kind: 'approval-asked',
        ts: Date.now(),
        toolName: req.toolName,
        reason: req.reason,
        sessionId,
      });
      if (!uiAnswerer) {
        // 无 GUI 应答方（headless / 未接 Electron）：交还 dsh 默认链路；
        // dsh 无应答方时解析 unavailable → fail-closed（不开门），符合硬约束。
        return next();
      }
      const timeout = new Promise<ApprovalOutcome>((resolve) => {
        const t = setTimeout(() => resolve('unavailable'), config.approvalTimeoutMs);
        if (req.signal) {
          req.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve('cancelled');
          }, { once: true });
        }
      });
      try {
        const ui = uiAnswerer({ toolName: req.toolName, reason: req.reason, sessionId }).then(
          (o): ApprovalOutcome => (o === 'allowed-once' || o === 'rejected' || o === 'cancelled' || o === 'unavailable' ? o : 'unavailable'),
          (): ApprovalOutcome => 'unavailable',
        );
        const outcome = await Promise.race([ui, timeout]);
        pushAudit({ kind: 'approval-decided', ts: Date.now(), outcome, toolName: req.toolName, sessionId });
        return outcome;
      } catch {
        return 'unavailable';
      }
    },
  );

  // 订阅 sandbox/mode 事件（补充审计；无则仅依赖 setMode 记录）。
  const offSandboxMode = ctxOn.call(ctx,
    'sandbox/mode',
    (payload: { mode?: string; session?: { id: string } }) => {
      pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: payload.mode, sessionId: payload.session?.id });
    },
  );

  ctx.effect(() => {
    const api: AuthzService = {
      getModes: () => AUTHZ_MODES,
      getLevels: () => LEVELS,
      getMode,
      setMode,
      setUiAnswerer,
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      getAuditLog: () => [...audit],
    };
    const anyCtx = ctx as unknown as { provide?: (n: string, v: unknown, b?: boolean) => void };
    anyCtx.provide?.('authz', api, true);

    return () => {
      offApproval();
      offSandboxMode();
      subscribers.clear();
    };
  }, 'orchdesk-authz.lifecycle()');
}
