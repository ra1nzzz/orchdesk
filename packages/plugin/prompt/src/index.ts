// OrchDesk 智能层 · 系统提示词库（T-P4-3，FR-11）。
//
// 防漂移（PRD FR-11 / PLAN.md T-P4-3）：
//   - 提示词与技能解耦：数据来自本插件（CRUD + 分类），不硬编码进任何插件代码。
//   - {skill:xxx} 引用语法：运行时展开 seam（host 经技能库解析真实内容，本插件只标记引用点）。
//   - 按 Agent 绑定 + 优先级合并：冲突（同字段/worldview 互斥）必须显式标记，不得静默覆盖。
//
// dsh 侧不提供提示词服务，故本插件为 OrchDesk 自建核心，保持薄：
//   - 真实持久化 / 技能展开 seam 由 host 在 dsh 运行时接入（本机 BUG-W02 门控）。

import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

export const name = 'orchdesk-prompt';

/** 提示词分类（PRD FR-11）。 */
export type PromptCategory = 'role' | 'safety' | 'format' | 'skill-link';
export const CATEGORIES: PromptCategory[] = ['role', 'safety', 'format', 'skill-link'];
export const CATEGORY_LABELS: Record<PromptCategory, string> = {
  role: '角色行为',
  safety: '安全边界',
  format: '输出格式',
  'skill-link': '技能联动',
};

export interface PromptDoc {
  id: string;
  title: string;
  category: PromptCategory;
  body: string;
  /** 绑定的 Agent id 列表（空 = 全局默认）。 */
  agents: string[];
  /** 合并优先级（数字小者优先；相同优先级冲突显式标记）。 */
  priority: number;
  updatedAt: number;
}

/** 合并后的段落：来自哪条 doc，是否冲突。 */
export interface MergedSection {
  fromDocId: string;
  fromTitle: string;
  category: PromptCategory;
  body: string;
  conflict: boolean;
  conflictWith?: string[];
}

export interface MergeResult {
  sections: MergedSection[];
  /** 显式标记出的冲突（field/语义互斥）。 */
  conflicts: Array<{ category: PromptCategory; docA: string; docB: string; reason: string }>;
}

export interface PromptConfig {
  /** 默认全局提示词 priority 基准。 */
  defaultPriority: number;
  /** 数据根（host 持久化）。 */
  dataRoot: string;
}

export const Config: z<PromptConfig> = z.object({
  defaultPriority: z.number().default(100),
  dataRoot: z.string().default('.orchdesk/prompt'),
});

// ---------- {skill:xxx} 引用解析 ----------

const SKILL_REF = /\{(skill|prompt):([a-z0-9._-]+)\}/gi;

export function extractSkillRefs(body: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  SKILL_REF.lastIndex = 0;
  while ((m = SKILL_REF.exec(body)) !== null) {
    if (m[1] === 'skill' && m[2]) refs.push(m[2]);
  }
  return [...new Set(refs)];
}

/** 展开 seam：host 注入技能内容解析器；默认原样保留引用标记（不静默吞掉）。 */
export type SkillResolver = (ref: string) => string | Promise<string>;

// ---------- 插件主体 ----------

let seqCounter = 0;
function nextId(): string {
  return `prompt-${Date.now().toString(36)}-${(++seqCounter).toString(36)}`;
}

export interface PromptService {
  list(): PromptDoc[];
  get(id: string): PromptDoc | undefined;
  create(doc: Omit<PromptDoc, 'id' | 'updatedAt'>): PromptDoc;
  update(id: string, patch: Partial<Omit<PromptDoc, 'id' | 'updatedAt'>>): PromptDoc | undefined;
  remove(id: string): boolean;
  /** 按 Agent 绑定 + 优先级合并；冲突显式标记。 */
  mergeForAgent(agentId: string): MergeResult;
  /** 设置 {skill:xxx} 展开 resolver（host 注入）。 */
  setSkillResolver(fn: SkillResolver): void;
  /** 展开某 doc 正文中的技能引用（供 host 拼装最终 system prompt）。 */
  resolveBody(doc: PromptDoc): Promise<string>;
}

export function apply(ctx: Context, config: PromptConfig): void {
  const docs = new Map<string, PromptDoc>();
  let resolver: SkillResolver | null = null;

  function create(doc: Omit<PromptDoc, 'id' | 'updatedAt'>): PromptDoc {
    const d: PromptDoc = { ...doc, id: nextId(), updatedAt: Date.now() };
    docs.set(d.id, d);
    return { ...d };
  }

  function update(id: string, patch: Partial<Omit<PromptDoc, 'id' | 'updatedAt'>>): PromptDoc | undefined {
    const cur = docs.get(id);
    if (!cur) return undefined;
    const next: PromptDoc = { ...cur, ...patch, id: cur.id, updatedAt: Date.now() };
    docs.set(id, next);
    return { ...next };
  }

  function remove(id: string): boolean {
    return docs.delete(id);
  }

  // 合并冲突检测：同 category 下若两条 doc 的 priority 相同且 body 语义不同 → 冲突。
  // 简化判定：相同 category + 相同 priority + 不同 body 哈希 → 显式冲突（不静默覆盖）。
  function detectConflict(a: PromptDoc, b: PromptDoc): string | null {
    if (a.category !== b.category) return null;
    if (a.priority !== b.priority) return null; // 不同优先级按优先级覆盖，不冲突
    if (a.body.trim() === b.body.trim()) return null;
    return `category=${a.category} priority=${a.priority} body-differ`;
  }

  function mergeForAgent(agentId: string): MergeResult {
    const relevant = [...docs.values()].filter((d) => d.agents.includes(agentId) || d.agents.length === 0);
    relevant.sort((a, b) => a.priority - b.priority || a.updatedAt - b.updatedAt);
    const conflicts: MergeResult['conflicts'] = [];
    const sectionByCat = new Map<PromptCategory, MergedSection[]>();

    for (const d of relevant) {
      const existing = sectionByCat.get(d.category) ?? [];
      // 检查与同 category 已有段落的冲突
      for (const sec of existing) {
        const c = detectConflict(d, docs.get(sec.fromDocId)!);
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

    const sections: MergedSection[] = [];
    for (const arr of sectionByCat.values()) sections.push(...arr);
    return { sections, conflicts };
  }

  async function resolveBody(doc: PromptDoc): Promise<string> {
    if (!resolver) return doc.body; // 未注入 resolver 时原样保留引用标记
    // 分段重建：对每个 skill 引用 await resolver（支持异步 resolver），
    // 非 skill 引用（prompt）原样保留；失败标记 unresolved，不吞异常。
    const out: string[] = [];
    let last = 0;
    for (const m of doc.body.matchAll(SKILL_REF)) {
      const idx = m.index ?? 0;
      out.push(doc.body.slice(last, idx));
      const kind = m[1] ?? '';
      const ref = m[2] ?? '';
      if (kind !== 'skill') {
        out.push(m[0]);
      } else {
        try {
          out.push(await resolver!(ref));
        } catch {
          out.push(`«skill:${ref}:unresolved»`);
        }
      }
      last = idx + m[0].length;
    }
    out.push(doc.body.slice(last));
    return out.join('');
  }

  const api: PromptService = {
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
    const anyCtx = ctx as unknown as { provide?: (n: string, v: unknown, b?: boolean) => void };
    anyCtx.provide?.('promptLib', api, true);
    return () => {
      docs.clear();
    };
  }, 'orchdesk-prompt.lifecycle()');
}
