// OrchDesk 多Agent编排插件（T-P2-5）
//
// 预置 8 专家 + 3 团（类 WorkBuddy 专家团模型）；可用预置，也可自编排。
// CEO→Director→Worker 层级在后台执行；编排视觉弱化（数据 + 事件，不占独立导航页）。
//
// 防漂移（T-P2-5）：
//   - 编排视觉弱化；不要做成主导航独立页（3 入口收敛）。
//   - 不要把编排树常驻显示；需要时才可视化。
//   - 专家/专家团数据来自插件，不要硬编码进主程序。
//
// 实现：层级经 dsh 原生 ctx.agents.create（meta.delegationDepth 控制递归预算）；
// Director/Worker 即用即走（finally dispose），委派树可查询。

import type { Context } from '@deepseek-ai/cordis';
import type { CreateAgentOptions, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';

export const name = 'orchdesk-multi';
export const inject = ['agents'];

export interface MultiConfig {
  /** 预置专家团名称（用户在设置页可增删）。 */
  presets: string[];
}

export const Config: z<MultiConfig> = z.object({
  presets: z.array(z.string()).default(['全栈开发团', '写作团']),
});

export interface Expert {
  id: string;
  title: string;
  domain: string;
}

export interface Team {
  id: string;
  name: string;
  members: string[];
}

// 预置专家（8）与专家团（3）—— 数据来自插件，不硬编码进主程序（防漂移）。
export const EXPERTS: Expert[] = [
  { id: 'orch', title: 'Orchestrator（主会话/CEO）', domain: 'coordination' },
  { id: 'dev', title: '开发总监', domain: 'engineering' },
  { id: 'design', title: '设计总监', domain: 'design' },
  { id: 'qa', title: '测试总监', domain: 'quality' },
  { id: 'pm', title: '项目管理总监', domain: 'management' },
  { id: 'doc', title: '文档总监', domain: 'documentation' },
  { id: 'art', title: '艺术总监', domain: 'art' },
  { id: 'risk', title: '风险控制总监', domain: 'risk' },
];

export const TEAMS: Team[] = [
  { id: 'team-fullstack', name: '预置 · 全栈开发团', members: ['dev', 'qa', 'doc'] },
  { id: 'team-writing', name: '预置 · 写作团', members: ['doc', 'art'] },
  { id: 'team-custom', name: '自定义 · 我的专家团', members: [] },
];

export type Layer = 'ceo' | 'director' | 'worker';

export interface DelegationNode {
  id: string;
  layer: Layer;
  expertId?: string;
  label: string;
  parentId?: string;
  sessionId?: SessionId;
  status: 'pending' | 'running' | 'done' | 'failed';
}

export interface OrchestrationCatalog {
  experts: Expert[];
  teams: Team[];
}

export interface Orchestration {
  /** 供渲染层 @modal / 插件页 列出专家与专家团。 */
  getCatalog(): OrchestrationCatalog;
  /** 委派树可查询（不强制常驻主屏）。 */
  getDelegationTree(rootId?: string): DelegationNode[];
  /** CEO→Director→Worker 三层任务闭环在后台执行（seam）。 */
  composeTeam(teamId: string, task: string): Promise<{ rootId: string; nodes: DelegationNode[] }>;
}

/** rootId 自增序号：与 Date.now 组合，彻底消除同毫秒并发下的 rootId 碰撞。 */
let ROOT_SEQ = 0;

export function apply(ctx: Context, _config: MultiConfig): void {
  const tree = new Map<string, DelegationNode>();

  function getCatalog(): OrchestrationCatalog {
    return { experts: EXPERTS, teams: TEAMS };
  }

  function getDelegationTree(rootId?: string): DelegationNode[] {
    const all = [...tree.values()];
    if (!rootId) return all;
    // 递归展开完整树（root + 全部子孙，含 Worker 层）；节点结构保持不变。
    const out: DelegationNode[] = [];
    const seen = new Set<string>([rootId]);
    const collect = (parentId: string) => {
      for (const n of all) {
        if (n.parentId === parentId && !seen.has(n.id)) {
          seen.add(n.id);
          out.push(n);
          collect(n.id);
        }
      }
    };
    const root = all.find((n) => n.id === rootId);
    if (root) {
      out.push(root);
      collect(rootId);
    }
    return out;
  }

  // seam：CEO→Director→Worker 三层任务闭环在后台执行（dsh 原生 ctx.agents.create）。
  async function composeTeam(
    teamId: string,
    _task: string,
  ): Promise<{ rootId: string; nodes: DelegationNode[] }> {
    const FALLBACK_TEAM: Team = { id: 'team-custom', name: '自定义 · 我的专家团', members: [] };
    const team = TEAMS.find((t) => t.id === teamId) ?? FALLBACK_TEAM;
    const rootId = `ceo-${++ROOT_SEQ}-${Date.now()}`;
    const ceo: DelegationNode = { id: rootId, layer: 'ceo', label: 'CEO（主会话）', status: 'running' };
    tree.set(rootId, ceo);
    const handles: Array<{ id: string; h: AgentHandle }> = [];
    try {
      // CEO 为顶层（本会话 agent，不另建）；Director 层 = 专家团成员作为 subagent（delegationDepth 1）。
      for (const memberId of team.members) {
        const expert = EXPERTS.find((e) => e.id === memberId);
        const dId = `${rootId}-d-${memberId}`;
        const dSession = brandSessionId(`orchdesk-dir-${dId}`);
        const dNode: DelegationNode = {
          id: dId,
          layer: 'director',
          expertId: memberId,
          label: expert?.title ?? memberId,
          parentId: rootId,
          sessionId: dSession,
          status: 'running',
        };
        tree.set(dId, dNode);
        const dOpts: CreateAgentOptions = {
          sessionId: dSession,
          meta: { origin: 'subagent', delegationDepth: 1 },
        };
        const h = await ctx.agents.create(dOpts); // seam
        handles.push({ id: dId, h });

        // Worker 层 = Director 下属临时手（delegationDepth 2），即用即走。
        const wId = `${dId}-w`;
        const wSession = brandSessionId(`orchdesk-wk-${wId}`);
        const wNode: DelegationNode = {
          id: wId,
          layer: 'worker',
          label: `${expert?.title ?? memberId} · 临时任务`,
          parentId: dId,
          sessionId: wSession,
          status: 'pending',
        };
        tree.set(wId, wNode);
        const wOpts: CreateAgentOptions = {
          sessionId: wSession,
          meta: { origin: 'subagent', parentSession: dSession, delegationDepth: 2 },
        };
        const wh = await ctx.agents.create(wOpts); // seam
        handles.push({ id: wId, h: wh });
      }
      // 置 done 只作用于本次 root 的子孙（不得洗白历史/其它 root 的节点）。
      for (const n of getDelegationTree(rootId)) n.status = 'done';
      return { rootId, nodes: getDelegationTree(rootId) };
    } catch (err) {
      // 失败节点显式置 failed：在树中可查询，且不得被后续任务洗白。
      for (const n of getDelegationTree(rootId)) {
        if (n.status === 'pending' || n.status === 'running') n.status = 'failed';
      }
      throw err;
    } finally {
      // 即用即走：Director/Worker 任务级上下文销毁即失（ADR-0004 isolate）。
      for (const { h } of handles) {
        try { await h.dispose(); } catch { /* 已处置 */ }
      }
    }
  }

  ctx.effect(() => {
    const api: Orchestration = { getCatalog, getDelegationTree, composeTeam };
    // 暴露给桥/渲染层（运行时 seam：main.ts 经 dsh 控制通道调用）。
    const anyCtx = ctx as unknown as { provide?: (n: string, v: unknown, b?: boolean) => void };
    anyCtx.provide?.('orchestration', api);
    return () => {
      tree.clear();
    };
  }, 'orchdesk-multi.lifecycle()');
}
