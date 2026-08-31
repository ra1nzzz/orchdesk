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
// 永久授权白名单（PRD FR-9「授权粒度：单次 / 会话 / 永久」的最后一块拼图）
// ----------------------------------------------------------------------------
// 三模式 + L0–L4 只解决了「什么级别要问」，没解决「问过一次之后怎么办」——
// 用户每次写同一个文件都要点确认。这里补上「会话 / 永久」两种记住粒度的规则：
//   规则 = 操作类型（tool）+ 路径白名单（pattern），可查看、可撤销。
// 匹配是 glob-lite：只支持 '*' 通配且整串锚定（不做部分匹配），避免
// '/tmp/a' 悄悄命中 '/tmp/ab/secret' 这类前缀逃逸。
// ---------------------------------------------------------------------------
export type GrantScope = 'session' | 'permanent';

export interface GrantRule {
  id: string;
  /** 工具名（file_write / shell_command / web_fetch …）；'*' = 任意工具。 */
  tool: string;
  /** 目标模式（路径 / 命令 / URL）；'*' = 任意目标。仅 '*' 通配，整串锚定。 */
  pattern: string;
  scope: GrantScope;
  /** scope='session' 时限定会话；'permanent' 恒为 undefined（跨会话生效）。 */
  sessionId?: string;
  createdAt: number;
  /** 命中次数（审计可见：判断某条白名单是否还在被用到）。 */
  hits: number;
  note?: string;
}

/** 可登记白名单的工具（'*' 兜底；未列出的工具仍可传，UI 只是不预置）。 */
export const GRANT_TOOLS: readonly string[] = ['*', 'file_write', 'shell_command', 'web_fetch'];

export function isGrantScope(v: unknown): v is GrantScope {
  return v === 'session' || v === 'permanent';
}

/**
 * glob-lite → 正则。'*' 单独出现等价于「任意」；其余 '*' 转 `[\s\S]*`，
 * 其余正则元字符全部转义，整串用 ^…$ 锚定。
 * @returns 非法模式返回 null（调用方按「不匹配」处理，fail-closed）。
 */
export function grantPatternToRegExp(pattern: string): RegExp | null {
  const p = String(pattern ?? '').trim();
  if (!p) return null;
  if (p === '*') return /^[\s\S]*$/;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*');
  try {
    return new RegExp('^' + escaped + '$');
  } catch {
    return null;
  }
}

export interface GrantInput {
  tool: string;
  pattern: string;
  scope: GrantScope;
  sessionId?: string;
  note?: string;
}

/**
 * 归一化并校验一条白名单规则。
 * 非法入参一律拒绝并给 reason —— 白名单是安全边界，静默丢弃会让用户
 * 以为「已经记住了」但实际没生效。
 */
export function normalizeGrant(input: unknown): { ok: boolean; rule?: GrantInput; reason?: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: '白名单规则缺失' };
  const raw = input as Record<string, unknown>;
  const tool = String(raw.tool ?? '').trim();
  if (!tool) return { ok: false, reason: '缺少操作类型（tool）' };
  const pattern = String(raw.pattern ?? '').trim();
  if (!pattern) return { ok: false, reason: '缺少目标模式（pattern）；不限目标请填 *' };
  if (grantPatternToRegExp(pattern) === null) return { ok: false, reason: `目标模式非法：${pattern}` };
  if (!isGrantScope(raw.scope)) return { ok: false, reason: `授权粒度非法：${String(raw.scope)}（应为 session 或 permanent）` };
  const sessionId = String(raw.sessionId ?? '').trim();
  if (raw.scope === 'session' && !sessionId) return { ok: false, reason: '会话级白名单必须指定 sessionId' };
  const note = String(raw.note ?? '').trim().slice(0, 120);
  return {
    ok: true,
    rule: {
      tool,
      pattern,
      scope: raw.scope,
      ...(raw.scope === 'session' ? { sessionId } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/**
 * 在规则集中找第一条命中的白名单。
 * 判定顺序：工具名（精确或 '*'）→ 粒度（session 需会话 ID 相等）→ 目标模式（整串锚定）。
 * 目标缺失时只有 '*' 模式能命中 —— 无目标的请求不该被真实路径规则放行。
 */
export function matchGrantRule(
  rules: readonly GrantRule[],
  q: { toolName?: string; target?: string; sessionId?: string },
): GrantRule | null {
  const tool = String(q?.toolName ?? '').trim();
  if (!tool) return null;
  const target = String(q?.target ?? '').trim();
  const sessionId = String(q?.sessionId ?? '').trim();
  for (const r of rules) {
    if (r.tool !== '*' && r.tool !== tool) continue;
    if (r.scope === 'session') {
      if (!r.sessionId || !sessionId || r.sessionId !== sessionId) continue;
    }
    const re = grantPatternToRegExp(r.pattern);
    if (!re) continue;
    if (!re.test(target)) continue;
    return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 审计日志条目
// ---------------------------------------------------------------------------
export type AuditKind =
  | 'approval-asked'
  | 'approval-decided'
  | 'sandbox-mode'
  | 'grant-added'
  | 'grant-revoked'
  | 'grant-matched';

export interface AuditEntry {
  kind: AuditKind;
  ts: number;
  /** 结构化可查询字段（不记录消息/路径原文，防 PII 泄露）。 */
  mode?: string;
  policy?: string;
  outcome?: string;
  toolName?: string;
  reason?: string;
  note?: string;
  sessionId?: string;
  /** 命中的白名单规则 ID（grant-matched / grant-revoked）。 */
  grantId?: string;
  /** 白名单粒度（session / permanent）。 */
  scope?: GrantScope;
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
  setMode(mode: AuthzMode, sessionId?: string): Promise<{ ok: boolean; reason?: string }>;
  /** 注入 GUI 应答回调（主进程桥接层在 Electron GUI 就绪后调用）。 */
  setUiAnswerer(fn: UiAnswerer | null): void;
  /** 订阅审计日志条目（供设置页/插件页检索渲染）。 */
  subscribe(cb: (e: AuditEntry) => void): () => void;
  /** 取审计日志快照（环形缓冲，最多 200 条）。 */
  getAuditLog(): AuditEntry[];

  // ---- PRD FR-9：会话 / 永久授权白名单（可查看、可撤销）----
  /** 列出全部白名单规则（含命中次数）。 */
  listGrants(): GrantRule[];
  /** 新增一条规则；非法入参拒绝并给 reason（不静默丢弃）。 */
  grant(input: unknown): { ok: boolean; rule?: GrantRule; reason?: string };
  /** 撤销单条；返回是否命中。 */
  revoke(id: string): boolean;
  /** 撤销全部（设置页「全部撤销」）；返回撤销条数。 */
  revokeAll(): number;
  /**
   * 判定是否被白名单放行。命中即 hits++ 并入审计（source=grant）。
   * 调用方仍应先判 paranoid —— 白名单不覆盖偏执模式（见 approvalGate）。
   */
  matchGrant(q: { toolName?: string; target?: string; sessionId?: string }): GrantRule | null;
  /** 宿主持久化接缝（dsh-runtime 落盘 authz-grants.json）。 */
  serializeGrants(): GrantRule[];
  hydrateGrants(list: unknown): void;
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
  // OrchDesk 桌面侧由 host-services 提供 sandboxPolicy 的真实实现（白名单 + 模式持久化），
  // 其 setSandboxMode 接受 { id } 形状，无需 dsh 的完整 Session 对象。
  const sandboxPolicy = (ctx as unknown as { sandboxPolicy?: {
    resolve(req?: { session?: { id: string } }): { mode: string };
    setSandboxMode(session: { id: string }, mode: string): void;
  } }).sandboxPolicy;
  const approval = (ctx as unknown as { approval?: {
    setPolicy(agent: unknown, policy: 'ask' | 'never'): void;
  } }).approval;

  async function getMode(sessionId?: string): Promise<AuthzMode> {
    // 解析当前生效的 SandboxMode → 反查 AuthzMode（default/trusted 同映射 workspace-write+ask，
    // 视作 default；paranoid 映射 read-only+never）。失败/不可用 → default（保守，不误报 paranoid）。
    try {
      const resolved = sandboxPolicy?.resolve(sessionId ? { session: { id: sessionId } } : {});
      const mode = resolved?.mode;
      const spec = AUTHZ_MODES.find((x) => x.sandboxMode === mode && x.approvalPolicy === 'never');
      return spec ? spec.id : 'default';
    } catch {
      return 'default';
    }
  }

  async function setMode(mode: AuthzMode, sessionId?: string): Promise<{ ok: boolean; reason?: string }> {
    const spec = modeToSpec(mode);
    // 1) sandbox/mode 持久化：经注入的 sandboxPolicy 落盘（无服务 → 失败，不静默）。
    if (!sandboxPolicy) {
      pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: spec.sandboxMode, policy: spec.approvalPolicy, sessionId, note: 'sandboxPolicy 服务未注入，切换未生效' });
      return { ok: false, reason: '沙箱策略服务不可用（sandboxPolicy 未注入），切换未生效' };
    }
    try {
      sandboxPolicy.setSandboxMode({ id: sessionId || '' }, spec.sandboxMode);
    } catch (err) {
      pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: spec.sandboxMode, policy: spec.approvalPolicy, sessionId, note: `持久化失败: ${(err as Error).message}` });
      return { ok: false, reason: `沙箱模式持久化失败：${(err as Error).message}` };
    }
    // 2) approval/policy：paranoid 对应 'never'（逐项确认），其余为 'ask'。
    try {
      approval?.setPolicy(undefined, spec.approvalPolicy);
    } catch { /* 策略同步失败不阻断模式切换，已落审计 */ }

    pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: spec.sandboxMode, policy: spec.approvalPolicy, sessionId });
    return { ok: true };
  }

  function setUiAnswerer(fn: UiAnswerer | null): void {
    uiAnswerer = fn;
  }

  // ---- PRD FR-9：会话 / 永久授权白名单 ----
  /** 规则集（持久化由宿主 dsh-runtime 经 serializeGrants/hydrateGrants 接管）。 */
  let grants: GrantRule[] = [];
  let grantSeq = 0;

  function grant(input: unknown): { ok: boolean; rule?: GrantRule; reason?: string } {
    const norm = normalizeGrant(input);
    if (!norm.ok || !norm.rule) return { ok: false, reason: norm.reason };
    // 同 tool+pattern+scope+session 视为重复：不新增，返回既有规则（幂等）。
    const dup = grants.find(
      (g) =>
        g.tool === norm.rule!.tool &&
        g.pattern === norm.rule!.pattern &&
        g.scope === norm.rule!.scope &&
        (g.sessionId || '') === (norm.rule!.sessionId || ''),
    );
    if (dup) return { ok: true, rule: dup };
    const rule: GrantRule = {
      ...norm.rule,
      id: `gr-${Date.now().toString(36)}-${++grantSeq}`,
      createdAt: Date.now(),
      hits: 0,
    };
    grants.push(rule);
    pushAudit({
      kind: 'grant-added',
      ts: rule.createdAt,
      toolName: rule.tool === '*' ? '（任意工具）' : rule.tool,
      note: `目标 ${rule.pattern}`,
      grantId: rule.id,
      scope: rule.scope,
      sessionId: rule.sessionId,
    });
    return { ok: true, rule };
  }

  function revoke(id: string): boolean {
    const before = grants.length;
    const target = grants.find((g) => g.id === id);
    grants = grants.filter((g) => g.id !== id);
    if (grants.length === before) return false;
    pushAudit({
      kind: 'grant-revoked',
      ts: Date.now(),
      toolName: target?.tool === '*' ? '（任意工具）' : target?.tool,
      note: `目标 ${target?.pattern ?? ''}`,
      grantId: id,
      scope: target?.scope,
      sessionId: target?.sessionId,
    });
    return true;
  }

  function revokeAll(): number {
    const n = grants.length;
    for (const g of grants) {
      pushAudit({ kind: 'grant-revoked', ts: Date.now(), toolName: g.tool, note: `目标 ${g.pattern}`, grantId: g.id, scope: g.scope, sessionId: g.sessionId });
    }
    grants = [];
    return n;
  }

  function matchGrant(q: { toolName?: string; target?: string; sessionId?: string }): GrantRule | null {
    const hit = matchGrantRule(grants, q);
    if (!hit) return null;
    hit.hits += 1;
    pushAudit({
      kind: 'grant-matched',
      ts: Date.now(),
      toolName: q.toolName,
      note: `命中白名单（累计 ${hit.hits} 次）`,
      grantId: hit.id,
      scope: hit.scope,
      sessionId: q.sessionId,
    });
    return hit;
  }

  function hydrateGrants(list: unknown): void {
    if (!Array.isArray(list)) return;
    const restored: GrantRule[] = [];
    for (const raw of list) {
      const norm = normalizeGrant(raw);
      if (!norm.ok || !norm.rule) continue; // 坏条目静默跳过（白名单宁缺勿滥）
      const id = String((raw as Record<string, unknown>).id ?? '').trim();
      const createdAt = Number((raw as Record<string, unknown>).createdAt);
      const hits = Number((raw as Record<string, unknown>).hits);
      restored.push({
        ...norm.rule,
        id: id || `gr-r-${Date.now().toString(36)}-${++grantSeq}`,
        createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
        hits: Number.isFinite(hits) && hits >= 0 ? Math.trunc(hits) : 0,
      });
    }
    grants = restored;
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
      // PRD FR-9：白名单命中即放行（hits++ 并入审计），不再惊动用户。
      // 偏执模式的拦截发生在主进程 approvalGate（白名单不覆盖 paranoid）。
      const hit = matchGrant({
        toolName: req.toolName,
        target: (req as { target?: string }).target,
        sessionId,
      });
      if (hit) return 'allowed-once';
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
      // FR-9 白名单
      listGrants: () => grants.map((g) => ({ ...g })),
      grant,
      revoke,
      revokeAll,
      matchGrant,
      serializeGrants: () => grants.map((g) => ({ ...g })),
      hydrateGrants,
    };
    const anyCtx = ctx as unknown as { provide?: (n: string, v: unknown, b?: boolean) => void };
    anyCtx.provide?.('authz', api);

    return () => {
      offApproval();
      offSandboxMode();
      subscribers.clear();
    };
  }, 'orchdesk-authz.lifecycle()');
}
