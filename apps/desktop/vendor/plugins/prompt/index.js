// OrchDesk 智能层 · 系统提示词库（T-P4-3，FR-11）。
//
// 防漂移（PRD FR-11 / PLAN.md T-P4-3）：
//   - 提示词与技能解耦：数据来自本插件（CRUD + 分类），不硬编码进任何插件代码。
//   - {skill:xxx} 引用语法：运行时展开 seam（host 经技能库解析真实内容，本插件只标记引用点）。
//   - 按 Agent 绑定 + 优先级合并：冲突（同字段/worldview 互斥）必须显式标记，不得静默覆盖。
//
// dsh 侧不提供提示词服务，故本插件为 OrchDesk 自建核心，保持薄：
//   - 真实持久化 / 技能展开 seam 由 host 在 dsh 运行时接入（本机 BUG-W02 门控）。
import z from '@deepseek-ai/schemastery';
export const name = 'orchdesk-prompt';
export const CATEGORIES = ['role', 'safety', 'format', 'skill-link'];
export const CATEGORY_LABELS = {
    role: '角色行为',
    safety: '安全边界',
    format: '输出格式',
    'skill-link': '技能联动',
};
export const Config = z.object({
    defaultPriority: z.number().default(100),
    dataRoot: z.string().default('.orchdesk/prompt'),
});
// ---------- {skill:xxx} 引用解析 ----------
const SKILL_REF = /\{(skill|prompt):([a-z0-9._-]+)\}/gi;
export function extractSkillRefs(body) {
    const refs = [];
    let m;
    SKILL_REF.lastIndex = 0;
    while ((m = SKILL_REF.exec(body)) !== null) {
        if (m[1] === 'skill' && m[2])
            refs.push(m[2]);
    }
    return [...new Set(refs)];
}
// ---------- 插件主体 ----------
let seqCounter = 0;
function nextId() {
    return `prompt-${Date.now().toString(36)}-${(++seqCounter).toString(36)}`;
}
export function apply(ctx, config) {
    const docs = new Map();
    let resolver = null;
    /**
     * 补全文档默认字段。
     * 缺陷修复：create/update 原样透传入参，若调用方未提供 agents/priority 等字段，
     * 后续 mergeForAgent 的 `d.agents.includes(...)` 会直接崩溃（undefined 访问）。
     */
    function normalizeDoc(doc) {
        const d = doc;
        return {
            ...d,
            title: d.title ?? '',
            body: d.body ?? '',
            category: d.category ?? 'role',
            agents: Array.isArray(d.agents) ? d.agents : [],
            priority: typeof d.priority === 'number' ? d.priority : 0,
        };
    }
    function create(doc) {
        const d = { ...normalizeDoc(doc), id: nextId(), updatedAt: Date.now() };
        docs.set(d.id, d);
        return { ...d };
    }
    function update(id, patch) {
        const cur = docs.get(id);
        if (!cur)
            return undefined;
        const merged = { ...cur, ...patch };
        const next = { ...normalizeDoc(merged), id: cur.id, updatedAt: Date.now() };
        docs.set(id, next);
        return { ...next };
    }
    function remove(id) {
        return docs.delete(id);
    }
    // 合并冲突检测：同 category 下若两条 doc 的 priority 相同且 body 语义不同 → 冲突。
    // 简化判定：相同 category + 相同 priority + 不同 body 哈希 → 显式冲突（不静默覆盖）。
    function detectConflict(a, b) {
        if (a.category !== b.category)
            return null;
        if (a.priority !== b.priority)
            return null; // 不同优先级按优先级覆盖，不冲突
        if (a.body.trim() === b.body.trim())
            return null;
        return `category=${a.category} priority=${a.priority} body-differ`;
    }
    function mergeForAgent(agentId) {
        // 防御式读取：历史文档可能缺 agents 字段（见 normalizeDoc 说明），
        // 不能用 d.agents.includes 直接访问，否则整个合并崩溃、提示词全部丢失。
        const relevant = [...docs.values()].filter((d) => {
            const agents = Array.isArray(d.agents) ? d.agents : [];
            return agents.includes(agentId) || agents.length === 0;
        });
        relevant.sort((a, b) => a.priority - b.priority || a.updatedAt - b.updatedAt);
        const conflicts = [];
        const sectionByCat = new Map();
        for (const d of relevant) {
            const existing = sectionByCat.get(d.category) ?? [];
            // 检查与同 category 已有段落的冲突
            for (const sec of existing) {
                const prev = docs.get(sec.fromDocId);
                if (!prev)
                    continue; // 文档已被移除，跳过（不崩）
                const c = detectConflict(d, prev);
                if (c) {
                    sec.conflict = true;
                    sec.conflictWith = [...(sec.conflictWith ?? []), d.id];
                    conflicts.push({ category: d.category, docA: sec.fromDocId, docB: d.id, reason: c });
                }
            }
            existing.push({
                fromDocId: d.id,
                fromTitle: d.title,
                category: d.category,
                body: d.body,
                conflict: false,
            });
            sectionByCat.set(d.category, existing);
        }
        const sections = [];
        for (const arr of sectionByCat.values())
            sections.push(...arr);
        return { sections, conflicts };
    }
    async function resolveBody(doc) {
        if (!resolver)
            return doc.body; // 未注入 resolver 时原样保留引用标记
        // 分段重建：对每个 skill 引用 await resolver（支持异步 resolver），
        // 非 skill 引用（prompt）原样保留；失败标记 unresolved，不吞异常。
        const out = [];
        let last = 0;
        for (const m of doc.body.matchAll(SKILL_REF)) {
            const idx = m.index ?? 0;
            out.push(doc.body.slice(last, idx));
            const kind = m[1] ?? '';
            const ref = m[2] ?? '';
            if (kind !== 'skill') {
                out.push(m[0]);
            }
            else {
                try {
                    out.push(await resolver(ref));
                }
                catch {
                    out.push(`«skill:${ref}:unresolved»`);
                }
            }
            last = idx + m[0].length;
        }
        out.push(doc.body.slice(last));
        return out.join('');
    }
    const api = {
        list: () => [...docs.values()],
        get: (id) => docs.get(id),
        create,
        update,
        remove,
        mergeForAgent,
        setSkillResolver: (fn) => {
            resolver = fn;
        },
        resolveBody,
    };
    ctx.effect(() => {
        const anyCtx = ctx;
        anyCtx.provide?.('promptLib', api);
        return () => {
            docs.clear();
        };
    }, 'orchdesk-prompt.lifecycle()');
}
//# sourceMappingURL=index.js.map