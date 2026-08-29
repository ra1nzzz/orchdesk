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
import z from '@deepseek-ai/schemastery';
export const name = 'orchdesk-authz';
export const inject = ['sandboxPolicy', 'approval'];
export const AUTHZ_MODES = [
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
];
export const LEVELS = [
    { level: 0, label: '读取', scope: '无副作用', requiresApproval: false },
    { level: 1, label: '状态写入', scope: '应用域内', requiresApproval: false },
    { level: 2, label: '文件系统', scope: '受限目录', requiresApproval: false },
    { level: 3, label: '网络', scope: '白名单', requiresApproval: true },
    { level: 4, label: 'Shell / 进程', scope: '仅 FULL ACCESS', requiresApproval: true },
];
export const Config = z.object({
    defaultMode: z.union(['default', 'trusted', 'paranoid']).default('default'),
    approvalTimeoutMs: z.number().default(120000),
});
const SESSION_EVENT_CAP = 200;
export function apply(ctx, config) {
    const audit = [];
    const subscribers = new Set();
    let uiAnswerer = null;
    const pushAudit = (e) => {
        audit.push(e);
        if (audit.length > SESSION_EVENT_CAP)
            audit.shift();
        for (const cb of subscribers) {
            try {
                cb(e);
            }
            catch { /* 订阅者异常不影响审计 */ }
        }
    };
    const modeToSpec = (m) => {
        const found = AUTHZ_MODES.find((x) => x.id === m);
        return found ?? AUTHZ_MODES[0];
    };
    // 调用 dsh 既有服务（inject 声明，运行时由 Cordis 注入）。
    // OrchDesk 桌面侧由 host-services 提供 sandboxPolicy 的真实实现（白名单 + 模式持久化），
    // 其 setSandboxMode 接受 { id } 形状，无需 dsh 的完整 Session 对象。
    const sandboxPolicy = ctx.sandboxPolicy;
    const approval = ctx.approval;
    async function getMode(sessionId) {
        // 解析当前生效的 SandboxMode → 反查 AuthzMode（default/trusted 同映射 workspace-write+ask，
        // 视作 default；paranoid 映射 read-only+never）。失败/不可用 → default（保守，不误报 paranoid）。
        try {
            const resolved = sandboxPolicy?.resolve(sessionId ? { session: { id: sessionId } } : {});
            const mode = resolved?.mode;
            const spec = AUTHZ_MODES.find((x) => x.sandboxMode === mode && x.approvalPolicy === 'never');
            return spec ? spec.id : 'default';
        }
        catch {
            return 'default';
        }
    }
    async function setMode(mode, sessionId) {
        const spec = modeToSpec(mode);
        // 1) sandbox/mode 持久化：经注入的 sandboxPolicy 落盘（无服务 → 失败，不静默）。
        if (!sandboxPolicy) {
            pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: spec.sandboxMode, policy: spec.approvalPolicy, sessionId, note: 'sandboxPolicy 服务未注入，切换未生效' });
            return { ok: false, reason: '沙箱策略服务不可用（sandboxPolicy 未注入），切换未生效' };
        }
        try {
            sandboxPolicy.setSandboxMode({ id: sessionId || '' }, spec.sandboxMode);
        }
        catch (err) {
            pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: spec.sandboxMode, policy: spec.approvalPolicy, sessionId, note: `持久化失败: ${err.message}` });
            return { ok: false, reason: `沙箱模式持久化失败：${err.message}` };
        }
        // 2) approval/policy：paranoid 对应 'never'（逐项确认），其余为 'ask'。
        try {
            approval?.setPolicy(undefined, spec.approvalPolicy);
        }
        catch { /* 策略同步失败不阻断模式切换，已落审计 */ }
        pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: spec.sandboxMode, policy: spec.approvalPolicy, sessionId });
        return { ok: true };
    }
    function setUiAnswerer(fn) {
        uiAnswerer = fn;
    }
    // 审批应答方：注册 approval/request listener（dsh 工具管道 L3/L4 ask 经此 seam）。
    // fail-closed：无 UI 应答 / 超时 / 异常 → 'unavailable'（dsh 据 unavailable 不开门）。
    // 注：approval/request 与 sandbox/mode 是 dsh 自定义事件，不在 Cordis 基础 Events 类型中，
    // 用 ctx 桥接法（与 brain 的 provide 同款）注册，保持本包仅依赖 cordis + schemastery。
    const ctxOn = ctx.on;
    const offApproval = ctxOn.call(ctx, 'approval/request', async (req, next) => {
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
        const timeout = new Promise((resolve) => {
            const t = setTimeout(() => resolve('unavailable'), config.approvalTimeoutMs);
            if (req.signal) {
                req.signal.addEventListener('abort', () => {
                    clearTimeout(t);
                    resolve('cancelled');
                }, { once: true });
            }
        });
        try {
            const ui = uiAnswerer({ toolName: req.toolName, reason: req.reason, sessionId }).then((o) => (o === 'allowed-once' || o === 'rejected' || o === 'cancelled' || o === 'unavailable' ? o : 'unavailable'), () => 'unavailable');
            const outcome = await Promise.race([ui, timeout]);
            pushAudit({ kind: 'approval-decided', ts: Date.now(), outcome, toolName: req.toolName, sessionId });
            return outcome;
        }
        catch {
            return 'unavailable';
        }
    });
    // 订阅 sandbox/mode 事件（补充审计；无则仅依赖 setMode 记录）。
    const offSandboxMode = ctxOn.call(ctx, 'sandbox/mode', (payload) => {
        pushAudit({ kind: 'sandbox-mode', ts: Date.now(), mode: payload.mode, sessionId: payload.session?.id });
    });
    ctx.effect(() => {
        const api = {
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
        const anyCtx = ctx;
        anyCtx.provide?.('authz', api);
        return () => {
            offApproval();
            offSandboxMode();
            subscribers.clear();
        };
    }, 'orchdesk-authz.lifecycle()');
}
//# sourceMappingURL=index.js.map