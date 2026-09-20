/**
 * 会话合并（读-改-写竞态修复）：
 * persist-sessions 以渲染层快照整表替换 store，而 agent-turn 同时在往 store 写
 * 模型回复——渲染层持旧快照时一次 persist 会把刚生成的 assistant 回复抹掉。
 *
 * 策略（main 侧写入优先，元数据渲染层权威）：
 *   - 仅存于 store 的会话：保留（main 侧创建的壳/回合产物，未提交删除）
 *   - 仅存于 incoming 的会话：采纳（渲染层新建）
 *   - 两侧都有：元数据取 incoming（title/pid 是 UI 操作），msgs 按去重键合并，
 *     stored 条目在冲突时优先（agent 回合产物不被旧快照回退）
 *   - incoming 缺失且 store 存在：视为用户删除——调用方（main.ts）需确认该会话
 *     没有进行中的 agent 回合才可删（见 persistSessions 的 hasActiveTurn 参数）
 *
 * 纯逻辑：不依赖 electron / fs，可 node 直测。
 */

/** 会话消息的最小形态（渲染层 {r,t,x} 与主进程 {role,text,t} 双 schema 兼容）。 */
export interface MergeableMessageLike {
  role?: string;
  r?: string;
  text?: string;
  x?: string;
  t?: string;
}

export interface MergeableSessionLike {
  id?: string;
  msgs?: MergeableMessageLike[];
  [k: string]: unknown;
}

function msgKey(m: MergeableMessageLike): string {
  const role = (m.role || m.r || '').toString();
  const text = (m.text || m.x || '').toString();
  const t = (m.t || '').toString();
  return `${role}|${t}|${text}`;
}

/**
 * 合并单个会话：元数据以 incoming 为准，msgs 去重合并（stored 优先、incoming 补充）。
 */
export function mergeSession<T extends MergeableSessionLike>(stored: T, incoming: T): T {
  const storedMsgs = Array.isArray(stored?.msgs) ? stored!.msgs! : [];
  const incomingMsgs = Array.isArray(incoming?.msgs) ? incoming!.msgs! : [];
  if (storedMsgs.length === 0) return incoming;
  if (incomingMsgs.length === 0) return stored;

  const seen = new Set(storedMsgs.map(msgKey));
  const extra = incomingMsgs.filter((m) => !seen.has(msgKey(m)));
  return { ...incoming, msgs: [...storedMsgs, ...extra] };
}

export interface MergeStoresResult<T extends MergeableSessionLike> {
  merged: Record<string, T>;
  deleted: string[];
  adopted: string[];
}

/**
 * 合并 store 与渲染层快照。
 * @param store 主进程当前存档（agent 回合写入方）
 * @param snapshot 渲染层全量快照（元数据权威方 / 删除权威方）
 * @param opts.isActive 会话是否有进行中的 agent 回合——有则即使 snapshot 缺失也不删
 */
export function mergeStores<T extends MergeableSessionLike>(
  store: Record<string, T>,
  snapshot: T[],
  opts: { isActive?: (id: string) => boolean } = {},
): MergeStoresResult<T> {
  const valid = (snapshot || []).filter((s) => s && s.id && Array.isArray(s.msgs));
  const snapIds = new Set(valid.map((s) => s.id!));
  const merged: Record<string, T> = {};
  const deleted: string[] = [];
  const adopted: string[] = [];

  // 1) store 侧：snapshot 缺失 → 删除（除非有进行中回合）；snapshot 有 → 合并
  for (const [id, cur] of Object.entries(store || {})) {
    const inc = valid.find((s) => s.id === id);
    if (!inc) {
      if (opts.isActive && opts.isActive(id)) { merged[id] = cur; }
      else deleted.push(id);
      continue;
    }
    merged[id] = mergeSession(cur, inc);
  }

  // 2) snapshot 侧：store 没有 → 采纳
  for (const inc of valid) {
    if (!merged[inc.id!]) { merged[inc.id!] = inc; adopted.push(inc.id!); }
  }

  return { merged, deleted, adopted };
}
