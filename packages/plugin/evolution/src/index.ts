// OrchDesk 自进化创造模式（T-P5-2，PRD FR-13）
//
// 职责（薄封装 dsh 既有 seam，不重写核心 —— 防漂移）：
//   1. Agent 运行时自建 / 卸载临时插件（信任级 = Shell、仅驻内存、重启即失）。
//   2. 自生成插件须经静态分析与授权门控（默认 CONFIRM + 沙箱内运行）。
//   3. fail-closed：静态分析命中危险模式，或授权门控未过 → 一律不加载。
//
// 关键约束（防漂移）：
//   - 临时插件信任级 = Shell，但运行必须在沙箱内，不给真实系统权限。
//   - 默认 CONFIRM，不要自动放行。
//   - 重启即失：仅驻内存（Map），不写磁盘、不进 bundle、不持久化。
//
// 实现依托 dsh 既有服务（依赖注入，不静态 import 审批包）：
//   - ctx.approval（@deepseek-ai/dsh-user-approval）：request（经 authz 的 UI 应答方弹窗）。
//   真实「在沙箱内实例化并执行临时插件」是 host/dsh isolate 的运行时 seam（本机 BUG-W02 门控），
//   本插件只管理生命周期 + 静态分析门控 + 授权门控，不自行 eval 用户代码。

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export const name = 'orchdesk-evolution';
export const inject = ['approval'];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export interface TempPluginSpec {
  name: string;
  /** 自生成的插件源码（host/Agent 经 LLM seam 产出）。 */
  code: string;
  description?: string;
}

export type TempPluginStatus = 'pending' | 'active' | 'disposed';

export interface TempPlugin {
  id: string;
  name: string;
  code: string;
  description?: string;
  /** 信任级固定为 Shell（最弱），实际运行仍受沙箱约束。 */
  trustLevel: 'shell';
  status: TempPluginStatus;
  /** 必须在沙箱内运行。 */
  requiresSandbox: boolean;
  createdAt: number;
  reason?: string;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
  /** 若允许，是否要求沙箱内运行（本插件恒为 true）。 */
  requiresSandbox: boolean;
}

export interface CreateResult {
  ok: boolean;
  plugin?: TempPlugin;
  reason?: string;
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

// ---------------------------------------------------------------------------
// 静态分析门控（fail-closed）
// ---------------------------------------------------------------------------
// 命中即拒绝（即便在沙箱内也过危险）：直接进程操控 / 任意代码执行 / 自杀。
const HARD_DENY: { pattern: RegExp; label: string }[] = [
  { pattern: /(child_process|\bexec(?:Sync)?\s*\(|\bspawn\s*\(|\bexecFile\s*\()/i, label: 'subprocess-exec' },
  { pattern: /(\beval\s*\(|\bnew\s+Function\s*\(|setTimeout\s*\(\s*['"`][^'"`]*\bexec\b)/i, label: 'arbitrary-eval' },
  { pattern: /(\bprocess\.exit\b|\bprocess\.kill\b|\bprocess\.abort\b)/i, label: 'process-kill' },
  { pattern: /(\brequire\s*\(\s*['"`](?!(\.\.?\/|\.)|safe-)[^'"`]*['"`]\s*\))/i, label: 'unsafe-require' },
  { pattern: /(\bimport\s*\(|from\s+['"`]https?:\/\/)/i, label: 'remote-import' },
  { pattern: /\bvm\.(runInThisContext|runInNewContext|createContext)\s*\(/i, label: 'vm-escape' },
];

// 命中则允许，但强制沙箱（跨边界能力）。
const SANDBOX_REQUIRED: { pattern: RegExp; label: string }[] = [
  { pattern: /(\bfs\.(write|append|unlink|rmdir|rm\s)|writeFileSync|appendFileSync|unlinkSync)/i, label: 'fs-write' },
  { pattern: /(\bhttp\.(get|post|request)|\bfetch\s*\(|axios|websocket)/i, label: 'network' },
  { pattern: /(\bDeno\b|\bBun\b)/i, label: 'alt-runtime' },
];

export function staticGate(spec: TempPluginSpec): GateResult {
  for (const rule of HARD_DENY) {
    if (rule.pattern.test(spec.code)) {
      return { allowed: false, reason: `静态分析命中硬拒绝模式：${rule.label}`, requiresSandbox: true };
    }
  }
  // 其余：允许，但强制沙箱（跨边界能力一律隔离）。
  let requiresSandbox = true;
  for (const rule of SANDBOX_REQUIRED) {
    if (rule.pattern.test(spec.code)) {
      requiresSandbox = true;
      break;
    }
  }
  if (!spec.name || spec.name.trim().length === 0) {
    return { allowed: false, reason: '插件名不能为空', requiresSandbox: true };
  }
  return { allowed: true, reason: '静态分析通过（强制沙箱）', requiresSandbox };
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
export interface EvolutionConfig {
  /** 是否将门控/创建/卸载事件写入审计日志。 */
  auditLog: boolean;
  /** 默认 CONFIRM：门控通过后仍需授权（true）。设为 false 等同自动放行，违反防漂移，保留但默认 true。 */
  requireConfirm: boolean;
}

export const Config: z<EvolutionConfig> = z.object({
  auditLog: z.boolean().default(true),
  requireConfirm: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------
export type AuditKind = 'gate' | 'create' | 'dispose';

export interface AuditEntry {
  kind: AuditKind;
  ts: number;
  pluginId?: string;
  name?: string;
  outcome?: string;
  reason?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// 服务接口（经 ctx.provide('evolution') 暴露给主进程桥 / 渲染层）
// ---------------------------------------------------------------------------
export interface EvolutionService {
  /** 静态分析门控（不触碰授权，纯检查）。 */
  requireGate(spec: TempPluginSpec): GateResult;
  /** 创建临时插件：先静态分析（fail-closed），通过后再授权门控（默认 CONFIRM）。
   *  成功则仅驻内存（status=active），不写磁盘、不持久化。 */
  createTempPlugin(spec: TempPluginSpec, opts?: { sessionId?: string; signal?: AbortSignal }): Promise<CreateResult>;
  /** 卸载临时插件（从内存移除；重启自动消失）。 */
  disposeTempPlugin(id: string): boolean;
  /** 列出当前驻内存的临时插件。 */
  list(): TempPlugin[];
  getAudit(): AuditEntry[];
  subscribe(cb: (e: AuditEntry) => void): () => void;
}

const AUDIT_CAP = 200;

export function apply(ctx: Context, config: EvolutionConfig): void {
  const plugins = new Map<string, TempPlugin>();
  const audit: AuditEntry[] = [];
  const subscribers = new Set<(e: AuditEntry) => void>();
  let seq = 0;

  const pushAudit = (e: AuditEntry): void => {
    audit.push(e);
    if (audit.length > AUDIT_CAP) audit.shift();
    for (const cb of subscribers) {
      try { cb(e); } catch { /* 订阅者异常不影响审计 */ }
    }
  };

  function list(): TempPlugin[] {
    return [...plugins.values()].filter((p) => p.status === 'active');
  }

  function disposeTempPlugin(id: string): boolean {
    const p = plugins.get(id);
    if (!p) return false;
    p.status = 'disposed';
    plugins.delete(id);
    if (config.auditLog) {
      pushAudit({ kind: 'dispose', ts: Date.now(), pluginId: id, name: p.name, outcome: 'disposed' });
    }
    return true;
  }

  async function createTempPlugin(
    spec: TempPluginSpec,
    opts?: { sessionId?: string; signal?: AbortSignal },
  ): Promise<CreateResult> {
    // 1) 静态分析门控（fail-closed）
    const gate = staticGate(spec);
    if (config.auditLog) {
      pushAudit({ kind: 'gate', ts: Date.now(), name: spec.name, outcome: gate.allowed ? 'pass' : 'deny', reason: gate.reason, sessionId: opts?.sessionId });
    }
    if (!gate.allowed) {
      return { ok: false, reason: gate.reason };
    }

    // 2) 授权门控（默认 CONFIRM）；fail-closed：无通道/未授权 → 不加载。
    let outcome: ApprovalOutcome = 'unavailable';
    if (config.requireConfirm) {
      const approval = (ctx as unknown as { approval?: { request?: (req: unknown, signal?: AbortSignal) => Promise<ApprovalOutcome> } }).approval;
      if (approval && typeof approval.request === 'function') {
        try {
          outcome = await approval.request(
            { toolName: `evolution:create:${spec.name}`, reason: '自生成临时插件需授权门控（默认 CONFIRM + 沙箱内运行）', sessionId: opts?.sessionId },
            opts?.signal,
          );
        } catch {
          outcome = 'unavailable';
        }
      }
      if (outcome !== 'allowed-once') {
        return { ok: false, reason: '授权门控未通过（默认 CONFIRM，未授权则不加载）' };
      }
    }

    // 3) 仅驻内存实例化（重启即失）。不写磁盘、不进 bundle。
    const id = `tmp-${Date.now().toString(36)}-${(++seq).toString(36)}`;
    const plugin: TempPlugin = {
      id,
      name: spec.name,
      code: spec.code,
      description: spec.description,
      trustLevel: 'shell',
      status: 'active',
      requiresSandbox: gate.requiresSandbox,
      createdAt: Date.now(),
      reason: 'in-memory only; sandbox required',
    };
    plugins.set(id, plugin);
    if (config.auditLog) {
      pushAudit({ kind: 'create', ts: Date.now(), pluginId: id, name: spec.name, outcome: 'active', reason: 'created in-memory (restart loses it)', sessionId: opts?.sessionId });
    }
    return { ok: true, plugin };
  }

  ctx.effect(() => {
    const api: EvolutionService = {
      requireGate: staticGate,
      createTempPlugin,
      disposeTempPlugin,
      list,
      getAudit: () => [...audit],
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
    };
    const anyCtx = ctx as unknown as { provide?: (n: string, v: unknown, b?: boolean) => void };
    anyCtx.provide?.('evolution', api, true);
    return () => {
      plugins.clear();
      subscribers.clear();
    };
  }, 'orchdesk-evolution.lifecycle()');
}
