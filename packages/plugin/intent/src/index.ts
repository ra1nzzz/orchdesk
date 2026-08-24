// OrchDesk 意图识别插件（T-P2-2）
//
// 挂点：dsh 的 `agent/pre-step`（waterfall 事件；每个被提议的 step 在 step/start
// 与模型请求之前触发一次，拒绝也入日志——必经性保证拦截不漏）。
// 决策（ADR-0003）：intent-gateway 实现为 in-process Cordis 插件，而非独立上游进程。
//
// 管线（docs/10-架构/architecture.md L111）：
//   F1–F4 Funnel → M1–M3 → 4-gate → ACT / CONFIRM / BLOCK
//
// - F1–F4 Funnel：廉价、常驻的规则风险漏斗（表层扫描 / 意图分类 / 爆炸半径 / 可逆性）。
// - M1–M3：M1 本地模型（qwen3:14b / Ollama）风险初筛；M2 结构化解析模型输出；
//   M3 确定性编译层——把模型裁决编译成「可验证动作描述」，**绝不直接执行 LLM 输出**（ADR-0003）。
// - 4-gate（fail-closed）：JSON 解析 / Schema / Stage allowlist / 参数范围；任一失败一律 BLOCK。
// - 决策：ACT 放行 / CONFIRM 软信号（放行但标记，真实交互确认在下游 approval seam，
//   即 T-P3-2）/ BLOCK 硬拒绝（入审计日志）。
//
// 注意：本地模型（Ollama）在本机不可用，属运行时 seam。模型不可用时跳过 M1–M3，
// 仅用 Funnel + defaultFallback（保守 CONFIRM，不静默放行）。所有注册走 ctx.on，
// 均为 Cordis effect，fiber 卸载时自动回滚（"启用=注册effect，停用=注册回滚，不重启"）。

import type { Context } from '@deepseek-ai/cordis';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';

export const name = 'orchdesk-intent';

type IntentDecision = 'ACT' | 'CONFIRM' | 'BLOCK';

/** 动作阶段（F2 分类 / M3 编译产物的枚举）。 */
type Stage =
  | 'read'
  | 'write-file'
  | 'exec-command'
  | 'network-send'
  | 'message-send'
  | 'query'
  | 'other';

type BlastRadius = 'none' | 'single-file' | 'directory' | 'system' | 'external';
type Reversibility = 'reversible' | 'irreversible';

export interface IntentConfig {
  /** 风险阈值（0–1），Funnel 分数高于此值进入 CONFIRM/BLOCK 分支。 */
  riskThreshold: number;
  /** 本地模型不可用时的保守回退：CONFIRM（默认，见 PLAN 防漂移）或 BLOCK。 */
  defaultFallback: 'CONFIRM' | 'BLOCK';
  /** 初筛用的本地模型（Ollama）。 */
  localModel: string;
  /** Ollama 服务基址。 */
  ollamaBaseUrl: string;
  /** 是否将 BLOCK/CONFIRM 决策写入审计日志。 */
  auditLog: boolean;
  /** Stage 白名单；编译出的动作阶段若不在此列表一律 BLOCK（fail-closed）。 */
  allowedStages: Stage[];
  /** 外发域名白名单；network-send 的目标域名不在列表一律 BLOCK。 */
  externalAllowlist: string[];
}

export const Config: z<IntentConfig> = z.object({
  riskThreshold: z.number().default(0.7),
  defaultFallback: z.union([z.const('CONFIRM'), z.const('BLOCK')]).default('CONFIRM'),
  localModel: z.string().default('qwen3:14b'),
  ollamaBaseUrl: z.string().default('http://127.0.0.1:11434'),
  auditLog: z.boolean().default(true),
  allowedStages: z
    .array(
      z.union([
        z.const('read'),
        z.const('write-file'),
        z.const('exec-command'),
        z.const('network-send'),
        z.const('message-send'),
        z.const('query'),
        z.const('other'),
      ]),
    )
    .default(['read', 'write-file', 'exec-command', 'network-send', 'message-send', 'query', 'other']),
  externalAllowlist: z.array(z.string()).default([]),
});

// ───────────────────────────── 文本提取 ─────────────────────────────

interface TextBlock {
  kind: 'text';
  text: string;
}

/** 从 UserMessage 抽取纯文本（content 可能是 string 或 ContentBlock[]，做宽容解析）。 */
function extractText(msg: UserMessage): string {
  const anyMsg = msg as unknown as { content?: unknown };
  const content = anyMsg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is TextBlock => !!b && (b as TextBlock).kind === 'text' && typeof (b as TextBlock).text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

// ───────────────────────────── F1–F4 Funnel ─────────────────────────────

/** F1 表层风险词表（保守，宁可多标不漏标）。 */
const F1_LEXEMES: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /(删除|清空|格式化|销毁|抹掉|del|delete|rm\s|rmdir|format|wipe)/i, weight: 0.4, label: 'destructive' },
  { pattern: /(drop\s+table|truncate|truncate\s+table|删库)/i, weight: 0.45, label: 'db-destructive' },
  { pattern: /(对外发送|发送邮件|send\s+email|群发|广播)/i, weight: 0.3, label: 'external-send' },
  { pattern: /(凭据|密码|私钥|token|密钥|\.env|secret|api[_-]?key)/i, weight: 0.3, label: 'secret' },
  { pattern: /(\/etc\/|\/root\/|C:\\\\Windows|C:\\\\Users\\\\.*\\.ssh|~\/)/i, weight: 0.35, label: 'system-path' },
  { pattern: /(格式化磁盘|全盘|所有文件|全部文件|整个系统|系统级)/i, weight: 0.3, label: 'system-wide' },
];

const F2_RULES: { pattern: RegExp; stage: Stage }[] = [
  { pattern: /(执行|运行|命令|cmd|shell|bash|powershell|script|脚本|npm|pnpm|pip|docker|git\s)/i, stage: 'exec-command' },
  { pattern: /(写入|保存|创建文件|写文件|生成文件|导出到|落盘|write\s|save\s|create\s+file)/i, stage: 'write-file' },
  { pattern: /(发送|发邮件|群发|对外|post\s|http|curl|请求接口|调用接口)/i, stage: 'network-send' },
  { pattern: /(问|查询|解释|总结|翻译|分析|怎么|如何|为什么|列出)/i, stage: 'query' },
  { pattern: /(读取|查看|打开|读文件|read\s|cat\s|show\s|display)/i, stage: 'read' },
];

const F3_WIDE: RegExp = /(所有|全部|整个|全盘|全局|every|all|system|系统级|.*\*)/i;

interface FunnelResult {
  f1: { hit: boolean; signals: string[]; weight: number };
  f2: { stage: Stage };
  f3: { radius: BlastRadius };
  f4: { reversible: Reversibility };
  score: number;
}

function funnel(text: string): FunnelResult {
  // F1 表层扫描
  const signals: string[] = [];
  let weight = 0;
  for (const rule of F1_LEXEMES) {
    if (rule.pattern.test(text)) {
      signals.push(rule.label);
      weight = Math.max(weight, rule.weight);
    }
  }
  // F2 意图分类（取首个命中规则；无命中归 query）
  let stage: Stage = 'query';
  for (const rule of F2_RULES) {
    if (rule.pattern.test(text)) {
      stage = rule.stage;
      break;
    }
  }
  // F3 爆炸半径
  const wide = F3_WIDE.test(text);
  let radius: BlastRadius = 'none';
  if (stage === 'network-send') radius = 'external';
  else if (stage === 'exec-command') radius = wide ? 'system' : 'directory';
  else if (stage === 'write-file') radius = wide ? 'directory' : 'single-file';
  // F4 可逆性：删除/外发/系统级不可逆
  const irreversible = stage === 'network-send' || (weight >= 0.4 && (radius === 'system' || radius === 'external'));
  const reversible: Reversibility = irreversible ? 'irreversible' : 'reversible';
  // 风险分：F1 权重 + 阶段 + 半径 + 不可逆
  let score = weight;
  if (stage === 'exec-command' || stage === 'network-send') score += 0.2;
  if (radius === 'system' || radius === 'external') score += 0.2;
  if (irreversible) score += 0.1;
  score = Math.min(1, score);
  return { f1: { hit: signals.length > 0, signals, weight }, f2: { stage }, f3: { radius }, f4: { reversible }, score };
}

// ───────────────────────────── M1–M3 ─────────────────────────────

interface ModelVerdict {
  stage: Stage;
  target: string;
  reversible: Reversibility;
  risk: number;
  params: Record<string, unknown>;
}

/** M1 本地模型调用 seam：经 Ollama /api/generate 取得原始输出；不可用返回 null。 */
async function callLocalModel(text: string, config: IntentConfig, signal: AbortSignal): Promise<string | null> {
  const prompt =
    '你是意图风险分类器。仅输出 JSON：' +
    '{"stage":"read|write-file|exec-command|network-send|message-send|query|other",' +
    '"target":"目标路径/命令/域名或空串","reversible":true|false,"risk":0到1,"params":{}}。' +
    '不要输出 JSON 以外的任何内容。用户输入：\n' +
    text;
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.localModel, prompt, stream: false, format: 'json' }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    return typeof data.response === 'string' ? data.response : null;
  } catch {
    return null; // 模型不可用 → seam 失败，走保守回退
  }
}

/** M2 结构化解析：从模型原始输出抽取 JSON 裁决。 */
function parseModelVerdict(raw: string): { ok: boolean; verdict?: ModelVerdict } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false };
  try {
    const obj = JSON.parse(match[0]) as Partial<ModelVerdict>;
    if (typeof obj.stage !== 'string' || typeof obj.reversible !== 'boolean' || typeof obj.risk !== 'number') {
      return { ok: false };
    }
    return {
      ok: true,
      verdict: {
        stage: obj.stage as Stage,
        target: typeof obj.target === 'string' ? obj.target : '',
        reversible: obj.reversible ? 'reversible' : 'irreversible',
        risk: Math.min(1, Math.max(0, obj.risk)),
        params: obj.params && typeof obj.params === 'object' ? obj.params : {},
      },
    };
  } catch {
    return { ok: false };
  }
}

/** M3 确定性编译层：把裁决编译成「可验证动作描述」。绝不直接执行 LLM 输出。 */
function compileAction(stage: Stage, target: string, reversible: Reversibility, params: Record<string, unknown>): ActionPreview {
  return { stage, target, reversible, params };
}

// ───────────────────────────── 4-gate（fail-closed） ─────────────────────────────

interface GateState {
  /** null = 本门因无模型输出而跳过（非失败）；false = 失败（fail-closed → BLOCK）。 */
  pass: boolean | null;
  detail: string;
}

interface ActionPreview {
  stage: Stage;
  target: string;
  reversible: Reversibility;
  params: Record<string, unknown>;
}

interface GateResults {
  g1: GateState; // JSON 解析（模型输出）
  g2: GateState; // Schema（动作描述合法）
  g3: GateState; // Stage allowlist
  g4: GateState; // 参数范围（路径/域名）
}

const KNOWN_STAGES: Stage[] = ['read', 'write-file', 'exec-command', 'network-send', 'message-send', 'query', 'other'];
const SYSTEM_PATH_RE = /(^|[\/\\])(etc|root|Windows|ProgramData|Users[\\\/][^\\\/]+[\\\/]\.ssh|Users[\\\/][^\\\/]+[\\\/]\.config)([\/\\]|$)/i;

function runGates(action: ActionPreview, config: IntentConfig, modelUsed: boolean): GateResults {
  // G1 JSON 解析：仅当模型可用时适用；无模型 → 跳过
  const g1: GateState = modelUsed
    ? { pass: true, detail: 'model output parsed' }
    : { pass: null, detail: 'skipped (no local model)' };
  // G2 Schema：动作描述字段齐全
  const g2: GateState = {
    pass:
      KNOWN_STAGES.includes(action.stage) &&
      typeof action.target === 'string' &&
      (action.reversible === 'reversible' || action.reversible === 'irreversible') &&
      typeof action.params === 'object',
    detail: 'action schema',
  };
  // G3 Stage allowlist：阶段必须在配置白名单
  const g3: GateState = {
    pass: config.allowedStages.includes(action.stage),
    detail: `stage=${action.stage}`,
  };
  // G4 参数范围：外发域名须白名单；写/执行绝对系统路径须拦截
  let g4Pass = true;
  let g4Detail = 'params within range';
  if (action.stage === 'network-send') {
    const host = (action.target || '').toLowerCase();
    if (!host || !config.externalAllowlist.some((d) => host.includes(d))) {
      g4Pass = false;
      g4Detail = `external host "${action.target}" not in allowlist`;
    }
  } else if ((action.stage === 'write-file' || action.stage === 'exec-command') && SYSTEM_PATH_RE.test(action.target || '')) {
    g4Pass = false;
    g4Detail = `system path blocked: ${action.target}`;
  }
  const g4: GateState = { pass: g4Pass, detail: g4Detail };
  return { g1, g2, g3, g4 };
}

// ───────────────────────────── 决策推导 ─────────────────────────────

interface IntentResult {
  decision: IntentDecision;
  modelUsed: boolean;
  funnel: FunnelResult;
  gates: GateResults;
  action: ActionPreview;
  reason: string;
}

function deriveDecision(funnel: FunnelResult, gates: GateResults, config: IntentConfig, modelUsed: boolean): IntentResult {
  const action = compileAction(funnel.f2.stage, '', funnel.f4.reversible, {});
  const destructive = funnel.f4.reversible === 'irreversible' && (funnel.f3.radius === 'system' || funnel.f3.radius === 'external');
  // fail-closed：任一硬门失败一律 BLOCK
  const failedGate = (['g1', 'g2', 'g3', 'g4'] as const).find((k) => gates[k].pass === false);
  if (failedGate) {
    return {
      decision: 'BLOCK',
      modelUsed,
      funnel,
      gates,
      action,
      reason: `gate ${failedGate} failed (${gates[failedGate].detail})`,
    };
  }
  // 高风险：不可逆 + 系统/外部级 → Funnel 直接拦截；否则 CONFIRM
  if (funnel.score >= config.riskThreshold) {
    if (destructive) {
      return { decision: 'BLOCK', modelUsed, funnel, gates, action, reason: 'irreversible system/external intent' };
    }
    return { decision: 'CONFIRM', modelUsed, funnel, gates, action, reason: `funnel score ${funnel.score.toFixed(2)} >= threshold` };
  }
  // 低风险：模型可用则 ACT；模型不可用走保守回退（不静默放行）
  if (!modelUsed) {
    return {
      decision: config.defaultFallback,
      modelUsed,
      funnel,
      gates,
      action,
      reason: `local model unavailable → defaultFallback=${config.defaultFallback}`,
    };
  }
  return { decision: 'ACT', modelUsed, funnel, gates, action, reason: 'clean pass' };
}

// ───────────────────────────── 审计 ─────────────────────────────

function audit(ctx: Context, result: IntentResult, config: IntentConfig): void {
  if (!config.auditLog) return;
  const summary = {
    plugin: 'orchdesk-intent',
    decision: result.decision,
    modelUsed: result.modelUsed,
    reason: result.reason,
    funnel: result.funnel,
    gates: result.gates,
    action: result.action,
  };
  const line = `[orchdesk-intent] ${result.decision} (${result.reason}) gates=${JSON.stringify(result.gates)}`;
  if (result.decision === 'BLOCK') ctx.logger?.warn?.(line);
  else ctx.logger?.info?.(line);
  // 结构化可查询审计（供将来 bridge / 设置页「审计日志」入口消费）
  ctx.logger?.info?.(`[orchdesk-intent:audit] ${JSON.stringify(summary)}`);
}

// ───────────────────────────── 插件入口 ─────────────────────────────

interface PreStepPayload {
  agent: Agent;
  messages: UserMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
}

export function apply(ctx: Context, config: IntentConfig): void {
  ctx.on('agent/pre-step', async (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const base = await next();
    if (base.kind === 'reject') return base;

    const lastUser = [...payload.messages]
      .reverse()
      .find((m) => (m as { source?: { kind?: string } }).source?.kind === 'user');
    if (!lastUser) return base;

    const text = extractText(lastUser);
    const funnelRes = funnel(text);

    // M1–M3：本地模型可用则编译动作；否则仅 Funnel。
    let modelUsed = false;
    let compiled: ActionPreview | null = null;
    const raw = await callLocalModel(text, config, payload.signal);
    if (raw != null) {
      const parsed = parseModelVerdict(raw);
      if (parsed.ok && parsed.verdict) {
        modelUsed = true;
        compiled = compileAction(parsed.verdict.stage, parsed.verdict.target, parsed.verdict.reversible, parsed.verdict.params);
      }
    }
    if (!compiled) {
      // 无模型 / 解析失败：以 Funnel 阶段作为动作（M3 降级编译）
      compiled = compileAction(funnelRes.f2.stage, '', funnelRes.f4.reversible, {});
    }

    const gates = runGates(compiled, config, modelUsed);
    const result = deriveDecision(funnelRes, gates, config, modelUsed);
    audit(ctx, result, config);

    if (result.decision === 'BLOCK') {
      // 硬拒绝（ADR-0003：reject 也关闭持久化轮次并入日志，必经性保证）
      return { kind: 'reject' };
    }
    // ACT / CONFIRM：放行；CONFIRM 为软信号（真实交互确认在下游 approval seam / T-P3-2）。
    // 不篡改用户 prompt 文本（避免污染到达模型的原始意图）。
    return { kind: 'enter', messages: base.kind === 'enter' ? base.messages : payload.messages };
  });
}
