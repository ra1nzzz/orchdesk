// OrchDesk TRACE 插件（T-P2-3 · 脱敏遥测）
//
// 设计溯源（不漂移）：
//   - T-P2-3（PLAN.md L228）/ PRD.md L184 / ui-ux.md L95：在 Agent Loop 前 +
//     Loop 结束，记录用户对语用意图的反馈，脱敏后遥测至用户显式配置的公开
//     GitHub 仓库。会话每条 Agent 消息底部 TRACE 反馈按钮（渲染层已在 P1 就绪）。
//   - 防漂移 4 条（PLAN.md L241-245）：① 脱敏必须彻底（路径/凭据/令牌/PII 不得上传）；
//     ② 上传失败不阻塞会话（离线缓存重试）；③ 仓库必须是用户显式配置的公开仓库
//     （不硬编码）；④ 只记录语用意图标签 + 反馈，不记录完整消息内容。
//
// 架构边界（与 T-P2-2 同源）：本插件运行在 main.ts spawn 的 dsh 子进程内。
// 渲染层 TRACE 按钮点击经桥 → dsh 控制通道 → 本插件的 `recordFeedback`
// （UI 假动作已就绪：app.js L663 toast；真实上传由本插件完成）。本机 Electron
// 运行时阻断（BUG-W02），故「GitHub 仓库可见上传记录」为运行期验收，受门控。
import z from '@deepseek-ai/schemastery';
export const name = 'orchdesk-trace';
export const Config = z.object({
    repoUrl: z.string().default(''),
    maskEnabled: z.boolean().default(true),
    cacheDir: z.string().default('.orchdesk/trace-cache'),
    token: z.string().default(''),
    batchSize: z.number().default(20),
});
// ---- 运行时状态 ----
let activeConfig = null;
/** 待上传队列（内存，满足「离线缓存重试」且上传失败不阻塞会话）。 */
const pending = [];
/** 上传失败的重试队列（指数退避）。 */
const retryQueue = [];
/**
 * 显式失败记录（如不支持的上传端点）：保留原因、可查询，不静默丢失。
 * 与 retryQueue 的区别：这类错误重试无意义（配置性问题），不参与退避重试。
 */
const errorQueue = [];
/** 最近一次上送/重试的真实异常文本（脱敏：只含状态码/原因，绝不含 token）。 */
let lastError = null;
let flushing = false;
/** 每个 agent 最近一次 Loop 前观测到的意图标签（供用户反馈关联，可选）。 */
const sessionIntent = new Map();
/** 安全读取环境变量（types:[] 下不依赖 @types/node）。 */
const env = globalThis.process
    ?.env || {};
// ---- 工具 ----
/** 稳定非加密哈希（djb2），仅用于避免泄露原始 id 形状，非安全用途。 */
function hashKey(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++)
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'k' + (h >>> 0).toString(36);
}
/** 从用户消息安全提取文本（ContentBlock.text），失败回退空串。 */
function extractText(messages) {
    try {
        const parts = [];
        for (const m of messages) {
            const content = m.content;
            if (Array.isArray(content)) {
                for (const block of content) {
                    const text = block.text;
                    if (typeof text === 'string')
                        parts.push(text);
                }
            }
        }
        return parts.join('\n');
    }
    catch {
        return '';
    }
}
/** 保守语用意图分类（只取标签，不记录原文）。 */
function classifyIntent(text) {
    const t = text.toLowerCase();
    if (/\b(rm\b|del|delete|format|drop table|rmdir|move|mv |remove)/.test(t))
        return 'exec';
    if (/(write|create|save|overwrite|put|生成文件|写文件|保存)/.test(t))
        return 'write';
    if (/(curl|wget|fetch|http|api|upload|download|post |send|请求|上传|下载)/.test(t))
        return 'network';
    if (/(邮件|email|发送给|@|message|通知|微信)/.test(t))
        return 'message';
    if (/(读|查看|read|cat |ls |list|查询|search|搜索|show|get )/.test(t))
        return 'read';
    if (/(为什么|如何|怎么|what|how|explain|解释|总结|分析)/.test(t))
        return 'query';
    return 'other';
}
/**
 * 脱敏防御层（防漂移①）：只保留白名单字段，丢弃任何非预期字段，确保即使上游
 * 误塞自由文本也不外泄。sessionKey/messageKey 已是哈希，不含原始路径/PII。
 */
export function mask(rec) {
    const clean = {
        v: 1,
        ts: rec.ts,
        sessionKey: rec.sessionKey,
        intent: rec.intent,
        feedback: rec.feedback,
        source: rec.source,
    };
    if (rec.messageKey)
        clean.messageKey = rec.messageKey;
    return clean;
}
// ---- 队列与上传 ----
function enqueue(rec) {
    const finalRec = activeConfig?.maskEnabled ? mask(rec) : rec;
    pending.push(finalRec);
    void scheduleFlush();
}
/** 触发批量上传（不阻塞调用方；仅当 pending 满足 batchSize 才发——enqueue 路径）。 */
async function scheduleFlush() {
    if (flushing || !activeConfig)
        return;
    if (pending.length < activeConfig.batchSize)
        return;
    await flush();
}
/**
 * 批量上传待发队列；失败移入重试队列（指数退避）。
 * 无 repoUrl / 无 token 时**不做出队**：记录保留在队列（不静默丢单），
 * 并在返回结果中体现未上送原因。
 */
export async function flush() {
    const result = {
        uploaded: 0,
        kept: pending.length,
        skippedReason: null,
        lastError: null,
    };
    if (flushing || !activeConfig) {
        result.skippedReason = activeConfig ? 'flush-in-progress' : 'plugin-inactive';
        return result;
    }
    flushing = true;
    lastError = null;
    try {
        while (pending.length > 0) {
            // 未配置仓库：不做出队，记录保留在队列（仓库不硬编码，防漂移③）。
            if (!activeConfig.repoUrl) {
                result.skippedReason = 'repo-url-not-configured';
                break;
            }
            // 非 github.com 端点：显式错误——记录进入 error 状态（可查询），不静默。
            const parsed = parseGitHubRepo(activeConfig.repoUrl);
            if ('error' in parsed) {
                const bad = pending.splice(0, pending.length);
                for (const rec of bad)
                    errorQueue.push({ rec, reason: parsed.error, at: Date.now() });
                result.skippedReason = parsed.error;
                break;
            }
            // 无 token：不做出队，记录保留在队列（公开仓库写操作需 token）。
            const token = activeConfig.token || env.ORCHDESK_TRACE_TOKEN || '';
            if (!token) {
                result.skippedReason = 'token-not-configured';
                break;
            }
            const batch = pending.splice(0, activeConfig.batchSize);
            try {
                await uploadBatch(batch);
                result.uploaded += batch.length;
            }
            catch (e) {
                // 失败时整批转入重试队列（不丢数据、不阻塞会话）；异常文本脱敏可查。
                lastError = e instanceof Error ? e.message : String(e);
                result.lastError = lastError;
                const nextAt = Date.now() + 30_000;
                for (const rec of batch)
                    retryQueue.push({ rec, attempt: 1, nextAt });
            }
        }
        result.kept = pending.length;
        await drainRetry();
        // drainRetry 内的真实异常也回填（flush 主循环未出错时以此为准）
        if (!result.lastError)
            result.lastError = lastError;
    }
    finally {
        flushing = false;
    }
    return result;
}
/**
 * 兜底上送（30s 定时器 / dispose 路径专用）：绕过 batchSize 门控，
 * 只受「无 repoUrl / 无 token」约束——低流量时滞留记录也能最终落网，
 * 进程退出不丢数据。
 */
export function flushNow() {
    return flush();
}
/** 处理重试队列（最多退避若干次，超限丢弃单条以免无限重试）。 */
async function drainRetry() {
    if (!activeConfig)
        return;
    const MAX_ATTEMPTS = 5;
    const now = Date.now();
    const due = retryQueue.filter((r) => r.nextAt <= now);
    if (due.length === 0)
        return;
    // 只移除已到期项，未到期项保留原次序（修复 splice(0, due.length) 误删队首未到期项）。
    const dueSet = new Set(due);
    for (let i = retryQueue.length - 1; i >= 0; i--) {
        const item = retryQueue[i];
        if (item && dueSet.has(item))
            retryQueue.splice(i, 1);
    }
    for (const item of due) {
        try {
            await uploadBatch([item.rec]);
        }
        catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            if (item.attempt < MAX_ATTEMPTS) {
                retryQueue.push({
                    rec: item.rec,
                    attempt: item.attempt + 1,
                    nextAt: Date.now() + Math.min(30_000 * 2 ** item.attempt, 600_000),
                });
            }
            // 超过上限：丢弃该条（遥测非关键，不无限占用内存）。
        }
    }
}
/**
 * 解析 GitHub repoUrl → { owner, repo }。
 * 仅支持 github.com 端点；其它端点返回显式 error（调用方据此进入记录 error 状态），
 * 不静默失败。
 */
function parseGitHubRepo(repoUrl) {
    const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:[/#]|$)/i);
    const owner = m?.[1];
    const repo = m?.[2];
    if (!owner || !repo)
        return { error: 'unsupported repoUrl: only github.com endpoints are supported' };
    return { owner, repo };
}
/**
 * 上传一批记录到用户配置的公开 GitHub 仓库（REST，无额外依赖；
 * octokit 可在 dsh 依赖层替换）。
 * 防漂移②③：repoUrl 必须用户配置；token 取 config/env，**绝不**进日志/payload。
 */
async function uploadBatch(batch) {
    const cfg = activeConfig;
    if (!cfg)
        throw new Error('plugin-inactive');
    const parsed = parseGitHubRepo(cfg.repoUrl);
    if ('error' in parsed)
        throw new Error(parsed.error); // 显式失败，不静默
    const token = cfg.token || env.ORCHDESK_TRACE_TOKEN || '';
    if (!token)
        throw new Error('token-not-configured'); // 显式失败，不静默
    const body = batch.map((b) => JSON.stringify(b)).join('\n');
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            // 声明本负载不含 PII（防御性元数据）。
            'X-Orchdesk-Trace': 'masked',
        },
        body: JSON.stringify({
            title: `[orchdesk-trace] ${batch.length} records @ ${(batch[0]?.ts ?? '').slice(0, 10)}`,
            body,
            labels: ['orchdesk-trace'],
        }),
    });
    if (!res.ok) {
        // 仅记录状态码，不记录 token / payload（防泄露）。
        throw new Error(`github upload failed: ${res.status}`);
    }
}
// ---- 对外 API（供桥 / 渲染层 TRACE 按钮调用） ----
/**
 * 记录一条用户反馈（Loop 结束用户主动标记的真实落点）。
 * `sessionKey` 来自渲染层 sid（经桥传入），内部再做一次哈希避免泄露原始形状。
 */
export function recordFeedback(intent, feedback, sessionKey, messageKey) {
    enqueue({
        v: 1,
        ts: new Date().toISOString(),
        sessionKey: sessionKey ? hashKey(sessionKey) : 'anonymous',
        messageKey: messageKey ? hashKey(messageKey) : undefined,
        intent,
        feedback,
        source: 'user',
    });
}
/** 供控制通道查询当前待发/重试/显式失败队列长度（可观测，不暴露内容）。 */
export function queueSize() {
    return { pending: pending.length, retry: retryQueue.length, errors: errorQueue.length };
}
/** 查询显式失败记录（如不支持的上传端点）：保留原因，可审计，不静默丢失。 */
export function errorRecords() {
    return errorQueue.map((e) => ({ rec: { ...e.rec }, reason: e.reason, at: e.at }));
}
// ---- 插件入口 ----
export function apply(ctx, config) {
    activeConfig = config;
    // Loop 前观测：每个 turn 起始（step===0）记录一次语用意图标签，不记消息内容。
    ctx.on('agent/pre-step', async (payload, next) => {
        if (payload.step === 0) {
            const agentId = payload.agent.id ?? `turn-${payload.turn}`;
            const key = hashKey(agentId);
            const intent = classifyIntent(extractText(payload.messages));
            sessionIntent.set(key, intent);
            enqueue({
                v: 1,
                ts: new Date().toISOString(),
                sessionKey: key,
                intent,
                feedback: null,
                source: 'pre-step',
            });
        }
        return next();
    });
    // Loop 结束的用户反馈由渲染层经桥 → recordFeedback 触发（见上）。
    // dsh 生命周期结束时（fiber dispose）可调用 flush() 确保未发记录落网。
    // 低流量兜底：batchSize 不满足时 scheduleFlush 直接返回，需定时器保证最终上送
    // （30s 间隔，仅在有 pending 时实际发送，避免空轮询）。
    // 定时器/dispose 路径走 flushNow()：绕过 batchSize 门控，只受「无 repoUrl/token」约束。
    const flushTimer = setInterval(() => {
        if (pending.length > 0 || retryQueue.length > 0)
            void flushNow();
    }, 30_000);
    ctx.effect(() => {
        return () => {
            clearInterval(flushTimer);
            // dispose 兜底：会话/进程退出前尽力上送滞留记录（不阻塞 dispose）。
            if (pending.length > 0 || retryQueue.length > 0)
                void flushNow();
        };
    }, 'orchdesk-trace.flush-timer()');
    void ctx;
}
//# sourceMappingURL=index.js.map