// OrchDesk 智能层 · 上下文转储召回 + 四域分层记忆（T-P4-1 / T-P4-2，FR-10）。
//
// 防漂移（PRD FR-10 / architecture.md / PLAN.md P4）：
//   - 转储不丢失原消息：SessionEvent 日志是不可变不变量，本插件只「产出伪记忆」+「标注已转储」，
//     绝不删除/改写原消息（dsh 拥有 SessionEvent）。
//   - 向量编码本地完成：TF-IDF 起步，绝不在 P4 调云端 embedding API（PRD NFR 本地优先）。
//   - 四域物理隔离：global / project / director / worker 各自独立 store，互不通混；host 持久化时
//     各落独立文件（dataRoot/{global,project,director,worker}.jsonl）。
//   - 晋升流 fail-closed：worker→director 必须过 brain.promoteWorkerOutput（默认拒绝）；
//     director→project / 任意→global 须显式操作并写审计。
//
// dsh 侧不提供记忆/向量服务，故本插件为 OrchDesk 自建核心，但保持薄：
//   - LLM 摘要、磁盘持久化、与 dsh 真实 token-budget 联动均为运行时 seam（本机 BUG-W02 门控）。
//   - 真实 spawn 升级路径经 brain 插件（ctx.get('brainHands')，可选）。
import z from '@deepseek-ai/schemastery';
export const name = 'orchdesk-memory';
export const DOMAINS = ['global', 'project', 'director', 'worker'];
export const Config = z.object({
    dumpThreshold: z.number().default(0.8),
    recallTopK: z.number().default(5),
    maxContextTokens: z.number().default(128000),
    keepRecent: z.number().default(6),
    maxEntriesPerDomain: z.number().default(200),
    dataRoot: z.string().default('.orchdesk/memory'),
});
// ---------- 本地 TF-IDF（起步方案，不调云端） ----------
function tokenize(text) {
    const lower = text.toLowerCase();
    const ascii = lower.match(/[a-z0-9]+/g) ?? [];
    const cjk = Array.from(lower.match(/[一-鿿]/g) ?? []);
    return [...ascii, ...cjk];
}
function tf(tokens) {
    const freq = {};
    for (const t of tokens)
        freq[t] = (freq[t] ?? 0) + 1;
    const n = tokens.length || 1;
    for (const k of Object.keys(freq))
        freq[k] = (freq[k] ?? 0) / n;
    return freq;
}
/** 在给定语料上构建 IDF。 */
function buildIdf(docs) {
    const df = {};
    for (const doc of docs) {
        const seen = new Set(doc);
        for (const t of seen)
            df[t] = (df[t] ?? 0) + 1;
    }
    const n = docs.length || 1;
    const idf = {};
    for (const k of Object.keys(df))
        idf[k] = Math.log((1 + n) / (1 + (df[k] ?? 0))) + 1;
    return idf;
}
function tfidf(tokens, idf) {
    const t = tf(tokens);
    const out = {};
    for (const k of Object.keys(t))
        out[k] = (t[k] ?? 0) * (idf[k] ?? 0);
    return out;
}
function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const k of Object.keys(a)) {
        const av = a[k] ?? 0;
        na += av * av;
        const bv = b[k];
        if (bv !== undefined)
            dot += av * bv;
    }
    for (const k of Object.keys(b)) {
        const bv = b[k] ?? 0;
        nb += bv * bv;
    }
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
/**
 * 从消息中提取纯文本。
 *
 * 缺陷修复：此前各处直接把 `m.content` 当字符串用（`.match` / `.slice`），
 * 但 dsh UserMessage.content 的原生形状是 `ContentBlock[]`
 * （`{ type: 'text', text: string }`）—— 遇到结构化消息会直接抛
 * "text.match is not a function"，让整个 agent/pre-step 链崩掉。
 * 这里统一做宽容解析（string / ContentBlock 数组 / 其它 → ''）。
 */
function messageText(msg) {
    const content = msg?.content;
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((b) => {
            if (typeof b === 'string')
                return b;
            if (b && typeof b === 'object' && b.type === 'text') {
                const t = b.text;
                return typeof t === 'string' ? t : '';
            }
            return '';
        })
            .join('\n');
    }
    return '';
}
function estTokens(input) {
    // 容错：非字符串一律按空处理，不让 token 估算成为崩溃源。
    const text = typeof input === 'string' ? input : messageText(input);
    // 启发式：英文 ~4 字符/token，CJK ~1.6 字符/token。
    const cjk = (text.match(/[一-鿿]/g) ?? []).length;
    const rest = text.length - cjk;
    return Math.ceil(cjk / 1.6 + rest / 4);
}
function summarizeExtractive(messages) {
    // 抽取式兜底摘要（无 LLM seam 时使用）：保留首尾若干条的关键内容。
    if (messages.length === 0)
        return '(empty)';
    const head = messages.slice(0, 3);
    const tail = messages.slice(-3);
    const parts = [...head, ...tail].map((m) => messageText(m).slice(0, 200));
    return `摘要（抽取式）：${parts.join(' | ')}`;
}
// ---------- 插件主体 ----------
let seqCounter = 0;
function nextId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${(++seqCounter).toString(36)}`;
}
export function apply(ctx, config) {
    const stores = {
        global: new Map(),
        project: new Map(),
        director: new Map(),
        worker: new Map(),
    };
    const dumps = [];
    let summarizeFn = null;
    let lastDumpAt = 0;
    const prune = (domain) => {
        const m = stores[domain];
        if (m.size <= config.maxEntriesPerDomain)
            return;
        const ordered = [...m.values()].sort((a, b) => a.createdAt - b.createdAt);
        const excess = m.size - config.maxEntriesPerDomain;
        for (let i = 0; i < excess; i++) {
            const victim = ordered[i];
            if (victim)
                m.delete(victim.id);
        }
    };
    function vectorizeCorpus() {
        const docs = [];
        for (const d of DOMAINS)
            for (const e of stores[d].values())
                docs.push(tokenize(e.text));
        return buildIdf(docs);
    }
    async function dump(sessionId, messages, opts) {
        const keep = Math.min(config.keepRecent, messages.length);
        const toDump = messages.slice(0, messages.length - keep);
        const summary = summarizeFn ? await summarizeFn(toDump) : summarizeExtractive(toDump);
        const idf = vectorizeCorpus();
        const vector = tfidf(tokenize(summary), idf);
        const domain = opts?.domain ?? 'project';
        const entryId = nextId('mem');
        const entry = {
            id: entryId,
            domain,
            text: summary,
            vector,
            source: { agent: opts?.agent, sessionId, origin: `dump:${sessionId}` },
            createdAt: Date.now(),
        };
        stores[domain].set(entryId, entry);
        prune(domain);
        const rec = {
            id: nextId('dump'),
            sessionId,
            messageRefs: toDump.map((m) => m.id ?? nextId('msg')),
            summary,
            memoryId: entryId,
            createdAt: Date.now(),
        };
        dumps.push(rec);
        lastDumpAt = rec.createdAt;
        return rec;
    }
    function recall(query, opts) {
        const idf = vectorizeCorpus();
        const qv = tfidf(tokenize(query), idf);
        const scope = opts?.domain ? [opts.domain] : ['project', 'global'];
        const scored = [];
        for (const d of scope) {
            for (const e of stores[d].values()) {
                scored.push({ entry: e, score: cosine(qv, e.vector) });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, opts?.k ?? config.recallTopK);
    }
    function record(domain, text, source) {
        const idf = vectorizeCorpus();
        const id = nextId('mem');
        const entry = {
            id,
            domain,
            text,
            vector: tfidf(tokenize(text), idf),
            source,
            createdAt: Date.now(),
        };
        stores[domain].set(id, entry);
        prune(domain);
        return entry;
    }
    async function promote(id, from, to) {
        const entry = stores[from].get(id);
        if (!entry)
            return { ok: false, reason: 'entry-not-found' };
        if (from === to)
            return { ok: false, reason: 'same-domain' };
        // worker → director：必须过 brain.promoteWorkerOutput（fail-closed，默认拒绝）。
        if (from === 'worker' && to === 'director') {
            const brain = ctx.get?.('brainHands');
            if (!brain)
                return { ok: false, reason: 'brain-filter-unavailable' };
            const r = await brain.promoteWorkerOutput(entry.text);
            if (!r.approved)
                return { ok: false, reason: `director-rejected:${r.reason}` };
        }
        // director → project / 任意 → global：显式晋升（写审计在 host 层，此处记来源）。
        const moved = { ...entry, domain: to, source: { ...entry.source, origin: `promote:${from}->${to}` }, createdAt: Date.now() };
        stores[to].set(moved.id, moved);
        stores[from].delete(id);
        prune(to);
        return { ok: true, reason: `promoted:${from}->${to}` };
    }
    const api = {
        getStats: () => ({
            global: stores.global.size,
            project: stores.project.size,
            director: stores.director.size,
            worker: stores.worker.size,
        }),
        dump,
        recall,
        record,
        promote,
        listDomain: (d) => [...stores[d].values()],
        queryDumps: (sessionId) => (sessionId ? dumps.filter((x) => x.sessionId === sessionId) : [...dumps]),
        setSummarize: (fn) => {
            summarizeFn = fn;
        },
        serializeDomains: () => ({
            global: [...stores.global.values()],
            project: [...stores.project.values()],
            director: [...stores.director.values()],
            worker: [...stores.worker.values()],
        }),
    };
    ctx.effect(() => {
        // 上下文阈值检测：agent/pre-step 中估算 token 占比，达 80% 触发自动转储。
        // 转储不删除原 SessionEvent（不可变不变量），只产出伪记忆以备召回注入。
        const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
            const msgs = payload.messages ?? [];
            // estTokens 内部已处理 string / ContentBlock[] 两种形状
            const total = msgs.reduce((s, m) => s + estTokens(m), 0);
            const ratio = total / (config.maxContextTokens || 1);
            if (ratio >= config.dumpThreshold && Date.now() - lastDumpAt > 30_000) {
                // 触发转储（fire-and-forget；异常不影响本次 pre-step 放行）。
                const sid = payload.agent?.session?.id ?? 'unknown';
                void dump(sid, msgs, {
                    agent: payload.agent?.meta?.id,
                }).catch(() => undefined);
            }
            return next();
        });
        const anyCtx = ctx;
        anyCtx.provide?.('memory', api);
        return () => {
            offPreStep();
            for (const d of DOMAINS)
                stores[d].clear();
            dumps.length = 0;
        };
    }, 'orchdesk-memory.lifecycle()');
}
//# sourceMappingURL=index.js.map