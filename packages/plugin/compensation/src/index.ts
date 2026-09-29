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

import type { Context } from '@deepseek-ai/cordis';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';

export const name = 'orchdesk-compensation';
export const inject = ['approval'];

// ---------------------------------------------------------------------------
// 外发操作分类
// ---------------------------------------------------------------------------
export type OutboundCategory =
  | 'delete-file'
  | 'external-message'
  | 'network-egress'
  | 'shared-file-write'
  | 'irreversible'
  | 'other';

/** 触发 withhold 的类别：覆盖 PLAN 输出三类外发（发消息/网络请求/写共享文件）
 *  + 验收三类高危（删除文件/对外发送/不可逆操作）。 */
export const WITHHOLD_CATEGORIES: readonly OutboundCategory[] = [
  'delete-file',
  'external-message',
  'network-egress',
  'shared-file-write',
  'irreversible',
];

interface CategoryRule {
  pattern: RegExp;
  category: OutboundCategory;
}

// 顺序即优先级：靠前的先命中。
// 缺陷修复：中文口语里外发常写成「发给客户」「推送给群里」，早期规则只覆盖
// 「发送/发邮件/群发」，导致这类明显的外发操作被归为 other → 绕过 withhold
// 二次确认（PRD FR-12 要求外发默认 CONFIRM）。这里补齐常见说法与英文写法。
//
// R3-13：英文词一律加词边界。早先是无边界子串匹配，普通对话被误判成高危类别：
//   commit 命中 commitment、API 命中 rapid、GET/POST 命中 budget/poster，
//   连带 rm\s 命中 confirm/perform、del\s 命中 model —— 误判即整回合弹二次确认，
//   确认被拒直接 reject 整个回合，属可感知误报。中文无边界问题，保持原子串。
//   HTTP 方法名（POST/GET/PUT）是协议字面量，单独一条**大小写敏感**规则：
//   随整表 /i 加边界仍会命中普通英文动词 get/put/post（「get the file」），
//   那不是网络外发。
const CATEGORY_RULES: CategoryRule[] = [
  { pattern: /(删除文件|删除|删掉|删去|清空|格式化|格式化磁盘|删库|\bdelete\b|\brmdir\b|\brm\s|\bdel\s|\btrash|\bwipe|\bdrop\s+table\b|\bshred|\berase|\bremove\s+all\b)/i, category: 'delete-file' },
  { pattern: /(发送|发邮件|群发|对外发送|发消息|广播|发给|发送给|寄给|推送给|转发给|回复给|私信|通知他|通知客户|\bnotify|\bsend\s+(?:email|message|to)\b|\bmessage-send\b|\bbroadcast\b|\breply\s+to\b|\bforward\s+to\b)/i, category: 'external-message' },
  { pattern: /\b(?:POST|GET|PUT)\b/, category: 'network-egress' },
  { pattern: /(请求接口|调用接口|调用API|网络请求|\bhttp|\bcurl\b|\bfetch\b|\bapi\s+call\b|\bwebhook\b|\bAPI\b)/i, category: 'network-egress' },
  { pattern: /(写入共享|上传到共享|保存到共享盘|写共享目录|写共享文件|\bshared\s+drive\b|\bupload\s+to\s+shared\b)/i, category: 'shared-file-write' },
  { pattern: /(发布|部署|提交|支付|转账|购买|下单|\bpublish\b|\bdeploy\b|\bgit\s+commit\b|\bpayment\b|\btransfer\b|\bpurchase\b)/i, category: 'irreversible' },
];

export function classifyOutbound(text: string): { category: OutboundCategory; reversible: boolean } {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) {
      const reversible = rule.category === 'shared-file-write'; // 其余均为不可逆/外发
      return { category: rule.category, reversible };
    }
  }
  return { category: 'other', reversible: true };
}

/** 归入 'other' 时的兜底跨边界措辞：fail-closed 保守拦截用（中文，无边界问题）。 */
const UNKNOWN_OUTBOUND_HINT = /(外发|发送|删除|部署|支付|发布)/i;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
export interface CompensationConfig {
  /** 是否将 withhold / 补偿动作写入审计日志。 */
  auditLog: boolean;
  /** 未知类别（无法归类）是否也要求 withhold（fail-closed，默认 true）。 */
  failClosedUnknown: boolean;
}

export const Config: z<CompensationConfig> = z.object({
  auditLog: z.boolean().default(true),
  failClosedUnknown: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------
export type AuditKind = 'withhold-asked' | 'withhold-decided' | 'compensation';

export interface AuditEntry {
  kind: AuditKind;
  ts: number;
  category?: OutboundCategory;
  /** 结构化可查询字段；不记录消息/路径原文，防 PII 泄露。 */
  outcome?: string;
  reason?: string;
  action?: string;
  note?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// 服务接口（经 ctx.provide('compensation') 暴露给主进程桥 / 渲染层）
// ---------------------------------------------------------------------------
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface WithholdResult {
  needsConfirm: boolean;
  category: OutboundCategory;
  reason: string;
  /** 给 UI 的「不可撤销」警示文案。 */
  warning: string;
}

export interface CompensationAction {
  id: string;
  category: OutboundCategory;
  /** 建议的撤回/补偿动作描述（不保证可完全撤销）。 */
  action: string;
  ts: number;
  note?: string;
}

export interface CompensationService {
  classify(text: string): { category: OutboundCategory; reversible: boolean };
  /** 该类别是否触发发送前二次确认（类别级；'other' 的 fail-closed 兜底见 withhold）。 */
  requiresWithhold(category: OutboundCategory): boolean;
  /** 对外发文本做 withhold 判定（pre-step 强制门与 UI 警示条共用同一口径）。 */
  withhold(text: string): WithholdResult;
  /** 发送后记录补偿动作（撤回/恢复/审计）。返回结构化动作记录。 */
  compensate(text: string, note?: string): CompensationAction;
  /** 取审计日志快照（环形缓冲，最多 200 条）。 */
  getAudit(): AuditEntry[];
  subscribe(cb: (e: AuditEntry) => void): () => void;
}

const AUDIT_CAP = 200;

/** 各类别对应的补偿动作建议（不宣称可完全撤销）。 */
function suggestCompensation(category: OutboundCategory): string {
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

export function apply(ctx: Context, config: CompensationConfig): void {
  const audit: AuditEntry[] = [];
  const subscribers = new Set<(e: AuditEntry) => void>();

  const pushAudit = (e: AuditEntry): void => {
    audit.push(e);
    if (audit.length > AUDIT_CAP) audit.shift();
    for (const cb of subscribers) {
      try { cb(e); } catch { /* 订阅者异常不影响审计 */ }
    }
  };

  function requiresWithhold(category: OutboundCategory): boolean {
    if (WITHHOLD_CATEGORIES.includes(category)) return true;
    // 'other'：已归类为安全类，不拦。fail-closed 的「未知类别」保守拦截不放在这里，
    // 统一由下面的 needsWithhold()（文本级）判定——pre-step 强制门与 UI 预判
    // withhold() 都走那一个函数，保证同一段文本只可能有一个结论。
    return false;
  }

  /** withhold 的 fail-closed 判定（文本级，唯一口径）。
   *  主进程 outboundGate() 判定外发是否需要确认时调的就是 withhold()；插件自己挂在
   *  agent/pre-step 的强制门若另起一套判定，同一段「外发/删除」文本就会出现「主进程拦、
   *  插件放行」两种相反结论，谁生效取决于调用时序（R3-8）。两处必须同源。 */
  function needsWithhold(text: string): boolean {
    const { category } = classifyOutbound(text);
    if (requiresWithhold(category)) return true;
    // 'other'：归不进已知外发类别，但文本里出现跨边界/不可逆措辞 → 按
    // failClosedUnknown（默认 true）保守拦截。无确认通道时由调用方 reject，不开门。
    return config.failClosedUnknown && category === 'other' && UNKNOWN_OUTBOUND_HINT.test(text);
  }

  function withhold(text: string): WithholdResult {
    const { category } = classifyOutbound(text);
    const needs = needsWithhold(text);
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

  function compensate(text: string, note?: string): CompensationAction {
    const { category } = classifyOutbound(text);
    const action = suggestCompensation(category);
    const rec: CompensationAction = {
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
  function extractText(msg: UserMessage): string {
    const anyMsg = msg as unknown as { content?: unknown };
    const content = anyMsg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      // dsh ContentBlock 判别字段为 type（TextBlock.type === 'text'），非 kind。
      return content
        .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text' && typeof (b as { text: string }).text === 'string')
        .map((b) => b.text)
        .join('\n');
    }
    return '';
  }

  const ctxOn = (ctx as unknown as { on(e: string, l: (...a: any[]) => any): () => void }).on;
  const offPre = ctxOn.call(ctx, 'agent/pre-step', async (
    payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const base = await next();
    if (base.kind === 'reject') return base;

    // 仅每 turn 第一步预判一次，避免逐步重复弹确认。
    if (payload.step !== 0) return base;

    const lastUser = [...payload.messages]
      .reverse()
      .find((m) => (m as { source?: { kind?: string } }).source?.kind === 'user');
    if (!lastUser) return base;

    const text = extractText(lastUser);
    const { category } = classifyOutbound(text);
    // 强制门与 withhold() 同口径（needsWithhold 是唯一判定处）——主进程 outboundGate
    // 对同一段文本给的结论必须和这里一致，否则谁生效取决于调用时序。
    const needs = needsWithhold(text);
    const sessionId = payload.agent?.session?.id;

    if (!needs) return base;

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
    const approval = (ctx as unknown as {
      approval?: { request?: (req: { agent: Agent; toolName: string; reason?: string; signal?: AbortSignal }) => Promise<ApprovalOutcome> };
    }).approval;
    let outcome: ApprovalOutcome = 'unavailable';
    if (approval && typeof approval.request === 'function') {
      try {
        outcome = await approval.request({
          agent: payload.agent,
          toolName: `outbound:${category}`,
          reason: '跨边界/不可逆外发操作需二次确认',
          signal: payload.signal,
        });
      } catch {
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
    const api: CompensationService = {
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
    const anyCtx = ctx as unknown as { provide?: (n: string, v: unknown, b?: boolean) => void };
    anyCtx.provide?.('compensation', api);
    return () => {
      offPre();
      subscribers.clear();
    };
  }, 'orchdesk-compensation.lifecycle()');
}
