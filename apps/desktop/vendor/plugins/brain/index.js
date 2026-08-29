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
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
export const name = 'orchdesk-brain';
export const inject = ['agents'];
export const Config = z.object({
    maxConcurrentSubagents: z.number().default(3),
    isolationEnabled: z.boolean().default(true),
    directorModel: z.string().default(''),
});
/**
 * 模块级 director 过滤 seam；null = 默认拒绝（fail-closed）。
 * 经 setDirectorFilter 注入，或在 apply 时从 config.directorFilter / ctx.directorFilter 读取。
 */
let directorFilter = null;
/** 注入 Director 过滤回调（FR-10 晋升 seam）；传 null 恢复默认拒绝。 */
export function setDirectorFilter(fn) {
    directorFilter = fn;
}
/** Director 过滤默认超时（fail-closed：超时即拒绝）。 */
const DIRECTOR_FILTER_TIMEOUT_MS = 5_000;
/** 给 promise 加超时；超时即 reject（调用方转为拒绝）。 */
function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('director-filter-timeout')), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
    });
}
/** 安全读取属性（Cordis Context 代理对未知服务属性访问会抛错）。 */
function safeGet(obj, key) {
    if (!obj)
        return undefined;
    try {
        return obj[key];
    }
    catch {
        return undefined;
    }
}
export function apply(ctx, config) {
    // director 过滤 seam（FR-10）：可经 config.directorFilter / ctx.directorFilter 注入，
    // 或经模块级 setDirectorFilter 注入；均未提供时保持 fail-closed 默认拒绝。
    // 注意：Cordis Context 是代理，访问未提供服务属性会抛错 → 必须安全读取。
    const cfgFilter = safeGet(config, 'directorFilter');
    const ctxFilter = safeGet(ctx, 'directorFilter');
    if (typeof cfgFilter === 'function')
        directorFilter = cfgFilter;
    else if (typeof ctxFilter === 'function')
        directorFilter = ctxFilter;
    const registry = new Map();
    const handles = new Map();
    const subscribers = new Set();
    let seq = 0;
    const emit = (e) => {
        for (const cb of subscribers) {
            try {
                cb(e);
            }
            catch { /* 订阅者异常不影响生命周期 */ }
        }
    };
    async function dispatchSubAgent(task) {
        if (config.maxConcurrentSubagents > 0 && registry.size >= config.maxConcurrentSubagents) {
            throw new Error(`subagent concurrency cap reached (${config.maxConcurrentSubagents})`);
        }
        const id = `W-${++seq}`;
        const sessionId = brandSessionId(`orchdesk-sub-${id}-${Date.now()}`);
        const rec = {
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
            const opts = {
                sessionId,
                meta: { origin: 'subagent', parentSession: task.parentSession, delegationDepth: 1 },
            };
            const handle = await ctx.agents.create(opts);
            handles.set(id, handle);
            rec.status = 'executing';
            emit({ kind: 'dispatch', record: { ...rec } });
            return { ...rec };
        }
        catch (err) {
            registry.delete(id);
            throw err;
        }
    }
    async function disposeSubAgent(id, result) {
        const rec = registry.get(id);
        if (!rec)
            return;
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
    // fail-closed：默认拒绝（无回调即拒），避免 Worker 直写全局记忆；有回调时：
    // 放行→晋升；回调抛错 / 超时 / 返回非真→拒绝。真实实现可调 Director 子 agent 评估。
    async function promoteWorkerOutput(output, opts) {
        const filter = directorFilter;
        if (!filter)
            return { approved: false, reason: 'director-filter-pending' };
        try {
            const allowed = await withTimeout(Promise.resolve(filter(output)), opts?.timeoutMs ?? DIRECTOR_FILTER_TIMEOUT_MS);
            if (allowed === true)
                return { approved: true, reason: 'director-approved' };
            return { approved: false, reason: 'director-rejected' };
        }
        catch (e) {
            return {
                approved: false,
                reason: `director-filter-error:${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }
    ctx.effect(() => {
        // 标记主/手角色（CEO vs Worker）：Worker（subagent origin）不污染主会话记忆。
        const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
            void payload;
            return next();
        });
        const api = {
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
        const anyCtx = ctx;
        anyCtx.provide?.('brainHands', api);
        return () => {
            offPreStep();
            for (const [id, handle] of handles) {
                try {
                    void handle.dispose();
                }
                catch { /* already disposed or unavailable */ }
            }
            registry.clear();
            handles.clear();
            subscribers.clear();
        };
    }, 'orchdesk-brain.lifecycle()');
}
//# sourceMappingURL=index.js.map