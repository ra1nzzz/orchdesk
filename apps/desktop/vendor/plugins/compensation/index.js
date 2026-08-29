// OrchDesk 补偿层（T-P5-1，PRD FR-12，论文 §6.1）
//
// 职责（薄封装 dsh 既有 seam，不重写核心 —— 防漂移）：
//   1. 外发操作（发消息 / 网络请求 / 写共享文件）发送前二次确认（withhold）。
//   2. 发送后撤回 / 补偿动作（删文件、撤回消息等），并记入审计。
//   3. 三类高危（删除文件 / 对外发送 / 不可逆操作）默认 CONFIRM，不可绕过。
//   4. 审计聚合：withhold 决策 + 补偿动作均入日志，补偿动作本身也入审计。
//
// 关键约束（防漂移 / 论文 §6.1 开放问题）：
//   - 补偿层无形式化保证，工程上保守：默认 CONFIRM，不要宣称能「完全撤销」。
//   - fail-closed：无确认通道（headless / 无 GUI 应答方）→ 拦截（reject），不开门。
//   - 补偿动作本身也入审计。
//
// 实现依托 dsh 既有服务（依赖注入，不静态 import 审批包）：
//   - ctx.approval（@deepseek-ai/dsh-user-approval）：request（经 authz 的 UI 应答方弹窗）。
//   真实 push 弹窗在 Electron 渲染层；本插件仅发起 request 并据 outcome 决定放行/拦截。
import z from '@deepseek-ai/schemastery';
export const name = 'orchdesk-compensation';
export const inject = ['approval'];
/** 触发 withhold 的类别：覆盖 PLAN 输出三类外发（发消息/网络请求/写共享文件）
 *  + 验收三类高危（删除文件/对外发送/不可逆操作）。 */
export const WITHHOLD_CATEGORIES = [
    'delete-file',
    'external-message',
    'network-egress',
    'shared-file-write',
    'irreversible',
];
// 顺序即优先级：靠前的先命中。
// 缺陷修复：中文口语里外发常写成「发给客户」「推送给群里」，早期规则只覆盖
// 「发送/发邮件/群发」，导致这类明显的外发操作被归为 other → 绕过 withhold
// 二次确认（PRD FR-12 要求外发默认 CONFIRM）。这里补齐常见说法与英文写法。
const CATEGORY_RULES = [
    { pattern: /(删除文件|删除|删掉|删去|清空|格式化|格式化磁盘|rm\s|rmdir|del\s|trash|wipe|drop\s+table|删库|shred|erase|remove\s+all)/i, category: 'delete-file' },
    { pattern: /(发送|发邮件|群发|对外发送|发消息|广播|发给|发送给|寄给|推送给|转发给|回复给|私信|通知他|通知客户|notify|send\s+(email|message|to)|message-send|broadcast|reply\s+to|forward\s+to)/i, category: 'external-message' },
    { pattern: /(请求接口|调用接口|调用API|网络请求|POST|GET|PUT|http|curl|fetch|api\s+call|webhook|API)/i, category: 'network-egress' },
    { pattern: /(写入共享|上传到共享|保存到共享盘|写共享目录|写共享文件|shared\s+drive|upload\s+to\s+shared)/i, category: 'shared-file-write' },
    { pattern: /(发布|部署|提交|支付|转账|购买|下单|publish|deploy|commit|payment|transfer|purchase)/i, category: 'irreversible' },
];
export function classifyOutbound(text) {
    for (const rule of CATEGORY_RULES) {
        if (rule.pattern.test(text)) {
            const reversible = rule.category === 'shared-file-write'; // 其余均为不可逆/外发
            return { category: rule.category, reversible };
        }
    }
    return { category: 'other', reversible: true };
}
export const Config = z.object({
    auditLog: z.boolean().default(true),
    failClosedUnknown: z.boolean().default(true),
});
const AUDIT_CAP = 200;
/** 各类别对应的补偿动作建议（不宣称可完全撤销）。 */
function suggestCompensation(category) {
    switch (category) {
        case 'delete-file':
            return '从回收站/备份恢复；记录被删路径以便追溯';
        case 'external-message':
            return '撤回消息（若通道支持）；否则记录已发内容与收件方';
        case 'network-egress':
            return '记录外发请求；必要时联系服务端作废 token/会话';
        case 'shared-file-write':
            return '从共享盘版本历史恢复上一版';
        case 'irreversible':
            return '记录不可逆操作；尝试业务侧回滚（如适用）';
        default:
            return '记录操作以便审计追溯';
    }
}
export function apply(ctx, config) {
    const audit = [];
    const subscribers = new Set();
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
    function requiresWithhold(category) {
        if (WITHHOLD_CATEGORIES.includes(category))
            return true;
        // 'other'：默认不拦（正常对话）；fail-closedUnknown 仅影响「无法归类」的保守处理，
        // 此处 'other' 视为已归类的安全类，不拦；真正的未知由调用方按配置决定。
        return false;
    }
    function withhold(text) {
        const { category, reversible } = classifyOutbound(text);
        const needs = requiresWithhold(category) || (config.failClosedUnknown && category === 'other' && /(外发|发送|删除|部署|支付|发布)/i.test(text));
        const reason = needs
            ? `检测到跨边界/不可逆外发操作（${category}）`
            : '未检测到跨边界外发操作';
        return {
            needsConfirm: needs,
            category,
            reason,
            warning: needs ? '⚠ 此操作不可撤销：发送前需二次确认' : '',
        };
    }
    function compensate(text, note) {
        const { category } = classifyOutbound(text);
        const action = suggestCompensation(category);
        const rec = {
            id: `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            category,
            action,
            ts: Date.now(),
            note,
        };
        if (config.auditLog) {
            pushAudit({ kind: 'compensation', ts: rec.ts, category, action, note, reason: 'post-hoc compensation recorded' });
        }
        return rec;
    }
    // ---- agent/pre-step 钩子：每 turn 起始（step===0）做一次跨边界外发预判 ----
    function extractText(msg) {
        const anyMsg = msg;
        const content = anyMsg.content;
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            // dsh ContentBlock 判别字段为 type（TextBlock.type === 'text'），非 kind。
            return content
                .filter((b) => !!b && b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join('\n');
        }
        return '';
    }
    const ctxOn = ctx.on;
    const offPre = ctxOn.call(ctx, 'agent/pre-step', async (payload, next) => {
        const base = await next();
        if (base.kind === 'reject')
            return base;
        // 仅每 turn 第一步预判一次，避免逐步重复弹确认。
        if (payload.step !== 0)
            return base;
        const lastUser = [...payload.messages]
            .reverse()
            .find((m) => m.source?.kind === 'user');
        if (!lastUser)
            return base;
        const { category } = classifyOutbound(extractText(lastUser));
        const needs = requiresWithhold(category);
        const sessionId = payload.agent?.session?.id;
        if (!needs)
            return base;
        pushAudit({
            kind: 'withhold-asked',
            ts: Date.now(),
            category,
            reason: `cross-boundary/irreversible outbound (${category})`,
            sessionId,
        });
        // 经 dsh approval seam 发起二次确认（CONFIRM）。
        // 签名（dsh user-approval ApprovalService.request(req)）：
        //   req 必含 agent（路由 + 审计挂在其 session 日志），signal 置于 req.signal。
        // 无 request 方法 / 无应答方 → fail-closed 拦截（reject），不开门。
        const approval = ctx.approval;
        let outcome = 'unavailable';
        if (approval && typeof approval.request === 'function') {
            try {
                outcome = await approval.request({
                    agent: payload.agent,
                    toolName: `outbound:${category}`,
                    reason: '跨边界/不可逆外发操作需二次确认',
                    signal: payload.signal,
                });
            }
            catch {
                outcome = 'unavailable';
            }
        }
        pushAudit({
            kind: 'withhold-decided',
            ts: Date.now(),
            category,
            outcome,
            reason: outcome === 'allowed-once' ? 'user confirmed' : 'withheld (fail-closed)',
            sessionId,
        });
        // allowed-once → 放行；其余（rejected/cancelled/unavailable）→ 拦截。
        if (outcome === 'allowed-once') {
            return { kind: 'enter', messages: base.kind === 'enter' ? base.messages : payload.messages };
        }
        return { kind: 'reject' };
    });
    ctx.effect(() => {
        const api = {
            classify: classifyOutbound,
            requiresWithhold,
            withhold,
            compensate,
            getAudit: () => [...audit],
            subscribe: (cb) => {
                subscribers.add(cb);
                return () => subscribers.delete(cb);
            },
        };
        const anyCtx = ctx;
        anyCtx.provide?.('compensation', api);
        return () => {
            offPre();
            subscribers.clear();
        };
    }, 'orchdesk-compensation.lifecycle()');
}
//# sourceMappingURL=index.js.map