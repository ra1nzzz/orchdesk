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
import z from '@deepseek-ai/schemastery';
export const name = 'orchdesk-evolution';
export const inject = ['approval'];
// ---------------------------------------------------------------------------
// 静态分析门控（fail-closed）
// ---------------------------------------------------------------------------
// 命中即拒绝（即便在沙箱内也过危险）：直接进程操控 / 任意代码执行 / 自杀。
const HARD_DENY = [
    { pattern: /(child_process|\bexec(?:Sync)?\s*\(|\bspawn\s*\(|\bexecFile\s*\()/i, label: 'subprocess-exec' },
    { pattern: /(\beval\s*\(|\(\s*0\s*,\s*eval\s*\)|\bnew\s+Function\s*\(|setTimeout\s*\(\s*['"`][^'"`]*\bexec\b)/i, label: 'arbitrary-eval' },
    { pattern: /(\bprocess\.exit\b|\bprocess\.kill\b|\bprocess\.abort\b|\bprocess\s*\[\s*['"`](?:exit|kill|abort|_linkedBinding)['"`]\s*\])/i, label: 'process-kill' },
    { pattern: /((?:globalThis|global|window)\s*\[\s*['"`](?:process|require|eval)['"`]\s*\])/i, label: 'global-escape' },
    { pattern: /\.constructor\s*\(\s*['"`]/i, label: 'prototype-escape' },
    { pattern: /(\brequire\s*\(\s*['"`](?!(\.\.?\/|\.)|safe-)[^'"`]*['"`]\s*\))/i, label: 'unsafe-require' },
    { pattern: /(\bimport\s*\(|from\s+['"`]https?:\/\/)/i, label: 'remote-import' },
    { pattern: /\bvm\.(runInThisContext|runInNewContext|createContext)\s*\(/i, label: 'vm-escape' },
];
// 命中则允许，但强制沙箱（跨边界能力）。
const SANDBOX_REQUIRED = [
    { pattern: /(\bfs\.(write|append|unlink|rmdir|rm\s)|writeFileSync|appendFileSync|unlinkSync)/i, label: 'fs-write' },
    { pattern: /(\bhttp\.(get|post|request)|\bfetch\s*\(|axios|websocket)/i, label: 'network' },
    { pattern: /(\bDeno\b|\bBun\b)/i, label: 'alt-runtime' },
];
export function staticGate(spec) {
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
export const Config = z.object({
    auditLog: z.boolean().default(true),
    requireConfirm: z.boolean().default(true),
});
const AUDIT_CAP = 200;
export function apply(ctx, config) {
    const plugins = new Map();
    const audit = [];
    const subscribers = new Set();
    let seq = 0;
    const pushAudit = (e) => {
        audit.push(e);
        if (audit.length > AUDIT_CAP)
            audit.shift();
        for (const cb of subscribers) {
            try {
                cb(e);
            }
            catch { /* 订阅者异常不影响审计 */ }
        }
    };
    function list() {
        return [...plugins.values()].filter((p) => p.status === 'active');
    }
    function disposeTempPlugin(id) {
        const p = plugins.get(id);
        if (!p)
            return false;
        p.status = 'disposed';
        plugins.delete(id);
        if (config.auditLog) {
            pushAudit({ kind: 'dispose', ts: Date.now(), pluginId: id, name: p.name, outcome: 'disposed' });
        }
        return true;
    }
    async function createTempPlugin(spec, opts) {
        // 1) 静态分析门控（fail-closed）
        const gate = staticGate(spec);
        if (config.auditLog) {
            pushAudit({ kind: 'gate', ts: Date.now(), name: spec.name, outcome: gate.allowed ? 'pass' : 'deny', reason: gate.reason, sessionId: opts?.sessionId });
        }
        if (!gate.allowed) {
            return { ok: false, reason: gate.reason };
        }
        // 2) 授权门控（默认 CONFIRM）；fail-closed：无通道 / 未授权 / 缺 agent 句柄 → 不加载。
        //    dsh ApprovalService.request(req) 契约：req 必含 agent（路由+审计），signal 置于 req.signal。
        let outcome = 'unavailable';
        if (config.requireConfirm) {
            const approval = ctx.approval;
            if (approval && typeof approval.request === 'function' && opts?.agent) {
                try {
                    outcome = await approval.request({
                        agent: opts.agent,
                        toolName: `evolution:create:${spec.name}`,
                        reason: '自生成临时插件需授权门控（默认 CONFIRM + 沙箱内运行）',
                        signal: opts?.signal,
                    });
                }
                catch {
                    outcome = 'unavailable';
                }
            }
            if (outcome !== 'allowed-once') {
                return { ok: false, reason: '授权门控未通过（默认 CONFIRM，未授权或不含 agent 句柄则不加载）' };
            }
        }
        // 3) 仅驻内存实例化（重启即失）。不写磁盘、不进 bundle。
        const id = `tmp-${Date.now().toString(36)}-${(++seq).toString(36)}`;
        const plugin = {
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
        const api = {
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
        const anyCtx = ctx;
        anyCtx.provide?.('evolution', api);
        return () => {
            plugins.clear();
            subscribers.clear();
        };
    }, 'orchdesk-evolution.lifecycle()');
}
//# sourceMappingURL=index.js.map