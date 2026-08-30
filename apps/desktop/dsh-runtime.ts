/// <reference types="electron" />
/**
 * OrchDesk dsh 运行时（Cordis Context + 宿主服务 + 9 个插件）
 * ----------------------------------------------------------------------------
 * 这是 PRD 差距盘点中「FR-7 至 FR-13 全部为空壳」的根因修复：
 * 过去 `packages/plugin/*` 的 2515 行实现从未被 Electron 加载，asar 里 dsh/cordis
 * 命中数为 0。本模块在主进程启动真实的 Cordis Context，装载：
 *
 *   1. orchdesk-host-services —— OrchDesk 自提供的 sandboxPolicy / approval / agents
 *   2. 9 个插件             —— intent / trace / authz / brain / multi / memory /
 *                              prompt / compensation / evolution
 *
 * 加载后 ctx 上可用的服务：
 *   authz · memory · orchestration · brainHands · promptLib · compensation · evolution
 * （intent / trace 无 provide，它们以 agent/pre-step 事件监听形式生效。）
 *
 * 注意：所有插件的 lib 产物是 ESM，而主进程编译产物是 CJS —— 用动态 import() 加载，
 * Node 22 / Electron 36 原生支持（require(esm)），无需改模块系统。
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { hostServices, getHostServices, type HostServices } from './host-services';
import { decryptWithKey } from './credentials';
import { getDataDir } from './data-dir';

/** TRACE 上报目标（OrchDesk 公开仓库；上传端 = GitHub Issues，NDJSON 批量）。 */
export const TRACE_REPO_URL = 'https://github.com/ra1nzzz/orchdesk';

/**
 * 组装 trace 插件配置（装载时注入，非运行时桥）：
 * - 用户开关：`<dataDir>/trace.json` `{ enabled: boolean }`，缺省 **true**；
 *   关闭 = repoUrl 置空 → 插件行为退化为「只缓冲不上传」（观测照旧，不静默丢数据）。
 * - TOKEN 加密内置：打包前 `node scripts/prepare-trace.cjs` 产出
 *   `build/trace-token.enc.json` + `build/trace-key.local`（随包），运行时解密；
 *   文件缺失（dev / 未内置）→ 空 token → 只缓冲（安全降级，与未配置等价）。
 * 诚实边界：密钥与密文同包是混淆级保护，不防逆向——内置 TOKEN 必须用最小权限。
 */
export function buildTraceConfig(baseConfig: Record<string, unknown>): Record<string, unknown> {
  const cfg = { ...baseConfig };
  cfg.repoUrl = TRACE_REPO_URL;
  cfg.maskEnabled = true;

  const dataDir = process.env.ORCHDESK_DATA_DIR || process.env.ORCHDESK_HOME || '';
  let enabled = true;
  if (dataDir) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(dataDir, 'trace.json'), 'utf-8')) as { enabled?: boolean };
      if (typeof f.enabled === 'boolean') enabled = f.enabled;
    } catch { /* 缺省开 */ }
  }
  if (!enabled) {
    cfg.repoUrl = '';
    return cfg;
  }

  try {
    // ORCHDESK_TRACE_BUILD_DIR：密闭测试 seam（真实产物在 build/ 会解出真 TOKEN，测试不可依赖）。
    const buildDir = process.env.ORCHDESK_TRACE_BUILD_DIR || path.join(__dirname, '..', 'build');
    const encJson = JSON.parse(fs.readFileSync(path.join(buildDir, 'trace-token.enc.json'), 'utf-8')) as { enc?: string };
    const keyHex = fs.readFileSync(path.join(buildDir, 'trace-key.local'), 'utf-8').trim();
    cfg.token = decryptWithKey(encJson.enc, keyHex);
  } catch {
    // 未内置（dev / 未跑 prepare-trace）→ 显式清空：只缓冲不上传（安全降级），
    // 不保留 schema 默认值或外部传入的残留。
    cfg.token = '';
  }
  return cfg;
}

/** 插件名清单（顺序即加载顺序）。 */
export const PLUGIN_NAMES = [
  'intent',
  'trace',
  'authz',
  'brain',
  'multi',
  'memory',
  'prompt',
  'compensation',
  'evolution',
] as const;

export type PluginName = (typeof PLUGIN_NAMES)[number];

export interface PluginLoadResult {
  name: PluginName;
  ok: boolean;
  /** fiber.state === 2 视为已激活 */
  active: boolean;
  error?: string;
}

export interface OrchDeskRuntime {
  ctx: Context;
  host: HostServices | null;
  plugins: PluginLoadResult[];
  /** 已激活插件数 / 总数 */
  activeCount: number;
}

let runtime: OrchDeskRuntime | null = null;

/**
 * 解析插件产物路径。
 * - 打包后：`vendor/plugins/<name>/index.js`（由 scripts/vendor-dsh.cjs 物化）
 * - 开发时：回落到 `packages/plugin/<name>/lib/index.js`（仓库源码树）
 */
function pluginEntry(name: string): string | null {
  const vendored = path.join(__dirname, '..', 'vendor', 'plugins', name, 'index.js');
  if (fs.existsSync(vendored)) return vendored;
  const dev = path.join(__dirname, '..', '..', '..', 'packages', 'plugin', name, 'lib', 'index.js');
  if (fs.existsSync(dev)) return dev;
  return null;
}

/**
 * Cordis 期望 inject 为对象形式（{ name: true }），而插件源码导出的是字符串数组。
 * 数组会被当成索引键对象（'0','1'），导致依赖永远解析不到 —— 这里统一归一化。
 */
function normalizeInject(mod: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...mod };
  const inject = out.inject;
  if (Array.isArray(inject)) {
    const obj: Record<string, boolean> = {};
    for (const k of inject) if (typeof k === 'string') obj[k] = true;
    out.inject = obj;
  }
  return out;
}

/**
 * 定位 vendored cordis 入口。
 * 关键（打包产物真机崩溃修复）：不能用 CJS 静态 `require('@deepseek-ai/cordis')` ——
 * asar 内模块的裸说明符解析不会落到包外的 `<approot>/node_modules`（extraFiles），
 * 真机报 "Cannot find module '@deepseek-ai/cordis'"。改用与插件一致的显式路径
 * ESM 动态加载（dynamicImport + pathToFileUrl），并惰性缓存构造器。
 */
function cordisEntry(): string {
  // dev：__dirname=apps/desktop/dist → ../node_modules/@deepseek-ai
  // 打包：__dirname=<approot>/resources/app.asar/dist → ../../../node_modules/@deepseek-ai（extraFiles 放在 app 根）
  // 逐级向上探测，兼容两种布局（asar 内的 node_modules 不存在，自然跳过）。
  const candidates = ['..', '../..', '../../..'].map((up) =>
    path.join(__dirname, up, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  );
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[candidates.length - 1]!;
}

let contextCtor: (new () => Context) | null = null;

async function loadContext(): Promise<new () => Context> {
  if (contextCtor) return contextCtor;
  const entry = cordisEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`未找到 cordis 产物（${entry}），请先运行 node scripts/vendor-dsh.cjs`);
  }
  const mod = (await dynamicImport(pathToFileUrl(entry))) as {
    Context?: unknown;
    default?: { Context?: unknown };
  };
  const C = (mod?.Context ?? mod?.default?.Context) as (new () => Context) | undefined;
  if (typeof C !== 'function') throw new Error(`cordis 入口异常（缺少 Context 导出）：${entry}`);
  contextCtor = C;
  return contextCtor;
}

/** 启动运行时。幂等：重复调用返回同一实例。 */
export async function startRuntime(): Promise<OrchDeskRuntime> {
  if (runtime) return runtime;

  const Context = await loadContext();
  const ctx = new Context();
  const plugins: PluginLoadResult[] = [];

  // 1) 宿主服务必须最先装载：后续 5 个插件注入 sandboxPolicy / approval / agents
  ctx.plugin(hostServices);
  await settle();

  // 2) 装载 9 个插件
  for (const name of PLUGIN_NAMES) {
    const entry = pluginEntry(name);
    if (!entry) {
      plugins.push({ name, ok: false, active: false, error: '未找到编译产物（需先 tsc 或运行 vendor-dsh）' });
      continue;
    }
    try {
      const mod = (await dynamicImport(pathToFileUrl(entry))) as Record<string, unknown>;
      const plugin = normalizeInject(mod);
      let config = typeof plugin.Config === 'function'
        ? (plugin.Config as (c: unknown) => unknown)({})
        : undefined;
      // TRACE：装载时注入内置 TOKEN + 上报目标 + 用户开关（见 buildTraceConfig）。
      if (name === 'trace' && config && typeof config === 'object') {
        config = buildTraceConfig(config as Record<string, unknown>) as never;
      }
      // 插件产物经动态 import 载入，形状由运行时保证；此处做一次收窄以通过 strict 检查。
      type CordisPlugin = Parameters<Context['plugin']>[0];
      const fiber = ctx.plugin(plugin as unknown as CordisPlugin, config as never);
      fibers.set(name, fiber);
      await settle();
      const st = (fiber as unknown as { state?: number }).state;
      const active = st === 2;
      plugins.push({ name, ok: true, active, error: active ? undefined : `fiber.state=${st}（依赖未满足）` });
      if (!active) console.warn(`[orchdesk] 插件 ${name} 未激活：fiber.state=${st}`);
    } catch (err) {
      const msg = (err as Error).message;
      plugins.push({ name, ok: false, active: false, error: msg });
      console.error(`[orchdesk] 插件 ${name} 加载失败:`, msg);
    }
  }

  const activeCount = plugins.filter((p) => p.active).length;
  console.log(`[orchdesk] dsh 运行时就绪：插件 ${activeCount}/${PLUGIN_NAMES.length} 已激活`);

  // 记忆持久化：装载后回灌 + 轮询落盘（第七死挂点）。
  const memApi = memoryApiOf(ctx);
  if (memApi) {
    hydrateMemory(memApi);
    scheduleMemoryPersist(memApi);
  }

  runtime = { ctx, host: getHostServices(), plugins, activeCount };
  return runtime;
}

/** 取已启动的运行时（未启动时返回 null）。 */
export function getRuntime(): OrchDeskRuntime | null {
  return runtime;
}

// ---- 记忆持久化（第七死挂点修复：此前 serializeDomains/dataRoot 无 host 接管，记忆仅进程内存，重启即清零）----

/** memory 插件 provide 的服务面（宿主持久化只依赖这两个方法）。 */
export interface MemoryPersistApi {
  serializeDomains(): Record<string, unknown[]>;
  hydrateDomains(snapshot: Record<string, unknown[]>): void;
}

const MEMORY_DOMAINS = ['global', 'project', 'director', 'worker'] as const;
let memorySaveTimer: NodeJS.Timeout | null = null;
let lastMemorySnapshot = '';

function memoryDir(): string {
  return path.join(getDataDir(), 'memory');
}

function memoryApiOf(ctx: Context): MemoryPersistApi | null {
  const v = (ctx as unknown as Record<string, unknown>)['memory'];
  if (!v || typeof v !== 'object') return null;
  const api = v as MemoryPersistApi;
  return typeof api.serializeDomains === 'function' && typeof api.hydrateDomains === 'function' ? api : null;
}

/** 立即落盘（快照级去重：无变化不写盘）。四域各一文件，物理隔离。 */
export function persistMemoryNow(api: MemoryPersistApi): void {
  try {
    const domains = api.serializeDomains();
    const snap = JSON.stringify(domains);
    if (snap === lastMemorySnapshot) return;
    const dir = memoryDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const d of MEMORY_DOMAINS) {
      fs.writeFileSync(path.join(dir, `${d}.json`), JSON.stringify(domains[d] ?? []), 'utf-8');
    }
    lastMemorySnapshot = snap;
  } catch (err) {
    // 持久化失败不阻断运行（记忆退化为进程内，与修复前行为一致）。
    console.warn('[orchdesk] 记忆持久化失败:', (err as Error).message);
  }
}

/** 启动回灌：从 dataDir()/memory/{domain}.json 恢复四域；坏文件/缺文件静默跳过对应域。 */
export function hydrateMemory(api: MemoryPersistApi): boolean {
  try {
    const dir = memoryDir();
    const snapshot: Record<string, unknown[]> = {};
    let restored = 0;
    for (const d of MEMORY_DOMAINS) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${d}.json`), 'utf-8'));
        snapshot[d] = Array.isArray(parsed) ? parsed : [];
      } catch {
        snapshot[d] = [];
      }
      restored += snapshot[d].length;
    }
    api.hydrateDomains(snapshot);
    lastMemorySnapshot = JSON.stringify(api.serializeDomains());
    if (restored > 0) console.log(`[orchdesk] 记忆已回灌：${restored} 条（${memoryDir()}）`);
    return restored > 0;
  } catch (err) {
    console.warn('[orchdesk] 记忆回灌失败:', (err as Error).message);
    return false;
  }
}

/** 变更轮询落盘（20s 去抖；写前比对快照，无变化零 IO）。 */
function scheduleMemoryPersist(api: MemoryPersistApi): void {
  if (memorySaveTimer) clearInterval(memorySaveTimer);
  memorySaveTimer = setInterval(() => persistMemoryNow(api), 20_000);
  memorySaveTimer.unref?.();
}

/** 单个插件的当前状态（供 UI 展示，不伪造）。 */
export interface PluginState {
  name: PluginName;
  active: boolean;
  /** 运行时是否可用（产物是否存在） */
  available: boolean;
  error?: string;
}

/** 查询全部插件状态。 */
export function getPluginStates(): PluginState[] {
  if (!runtime) {
    return PLUGIN_NAMES.map((name) => ({ name, active: false, available: false, error: '运行时未启动' }));
  }
  return runtime.plugins.map((p) => ({
    name: p.name,
    active: p.active,
    available: p.ok,
    error: p.error,
  }));
}

/**
 * 真实热插拔（FR-3）：启用 = 注册 effect；停用 = 逆回滚（fiber.dispose），不重启、无残留。
 * @returns 操作后的状态；产物缺失或名字未知时明确报错，不做乐观更新。
 */
export async function setPluginEnabled(name: string, enabled: boolean): Promise<PluginState> {
  if (!runtime) throw new Error('运行时未启动');
  if (!PLUGIN_NAMES.includes(name as PluginName)) throw new Error(`未知插件: ${name}`);

  const entry = pluginEntry(name);
  if (!entry) throw new Error(`插件 ${name} 产物缺失（需先编译）`);

  const record = runtime.plugins.find((p) => p.name === name);
  const fiber = fibers.get(name);
  const isActive = !!record?.active;

  if (enabled && !isActive) {
    const mod = (await dynamicImport(pathToFileUrl(entry))) as Record<string, unknown>;
    const plugin = normalizeInject(mod);
    const config = typeof plugin.Config === 'function'
      ? (plugin.Config as (c: unknown) => unknown)({})
      : undefined;
    type CordisPlugin = Parameters<Context['plugin']>[0];
    const f = runtime.ctx.plugin(plugin as unknown as CordisPlugin, config as never) as unknown as FiberLike;
    fibers.set(name, f);
    await settle();
    const st = f.state;
    if (record) {
      record.active = st === 2;
      record.ok = true;
      record.error = st === 2 ? undefined : `fiber.state=${st}（依赖未满足）`;
    }
  } else if (!enabled && isActive && fiber) {
    if (typeof fiber.dispose === 'function') await Promise.resolve(fiber.dispose());
    fibers.delete(name);
    if (record) { record.active = false; record.error = '已停用（逆回滚完成）'; }
  }

  runtime.activeCount = runtime.plugins.filter((p) => p.active).length;
  const after = runtime.plugins.find((p) => p.name === name);
  return {
    name: name as PluginName,
    active: !!after?.active,
    available: !!after?.ok,
    error: after?.error,
  };
}

/** 已装载插件的 fiber 句柄（用于热插拔 dispose）。 */
interface FiberLike { state?: number; dispose?: () => Promise<void> | void }
const fibers = new Map<string, FiberLike>();

/**
 * 取插件注册的服务。插件未激活或服务未注册时返回 null —— 调用方必须判空，
 * 不允许静默回落到假数据（项目铁律：不伪造、不静默）。
 */
export function getService<T>(name: string): T | null {
  if (!runtime) return null;
  const value = (runtime.ctx as unknown as Record<string, unknown>)[name];
  return (value ?? null) as T | null;
}

// ---------------------------------------------------------------------------
// 挂点桥接（ADR-0008）
// ---------------------------------------------------------------------------
// PLAN T-P1-5 原设想主会话完整走 dsh AgentLoop（ctx.agents.followup 事件驱动）。
// 工程现实：Electron IPC 是请求-响应模型，而 followup 是 fire-and-forget 的 inbox
// 驱动（见 dsh runtime-types），全量切换需要同步改造工具映射/模型配置/会话体系。
// v1 裁决：主回合**手动驱动 dsh 的挂点 waterfall**——intent（意图网关）与 trace
// （遥测）都挂在 `agent/pre-step` 上，此前主会话绕过 AgentLoop 导致这两个 PRD
// 亮点在主链路上从未触发。完整 AgentLoop 事件化列入路线图（见 ADR-0008）。

export interface PreStepDecisionLike {
  kind?: string;
  reason?: string;
  messages?: unknown[];
}

/**
 * 驱动 `agent/pre-step` waterfall（intent 门控 + trace 观测的必经挂点）。
 * 运行时未启动或 ctx 无 waterfall 能力 → 返回 null（调用方决定放行策略：
 * 基础设施缺失 ≠ 风险输入放行，执行侧仍有沙箱白名单/命令白名单兜底）。
 */
export async function firePreStep(payload: {
  sessionId: string;
  text: string;
  /** 完整会话正文（历史回灌 + 当前输入 + system）：memory 插件的 80% 阈值检测
   *  按 payload.messages 总 token 估算占比，只传单条会让阈值检测形同虚设。 */
  messages?: string[];
  turn?: number;
  step?: number;
}): Promise<PreStepDecisionLike | null> {
  if (!runtime) return null;
  const wf = (runtime.ctx as unknown as {
    waterfall?: (ev: string, p: unknown, base: () => Promise<unknown>) => Promise<PreStepDecisionLike | undefined>;
  }).waterfall;
  if (typeof wf !== 'function') return null;
  const texts = payload.messages?.length ? payload.messages : [payload.text];
  const decision = await wf.call(runtime.ctx, 'agent/pre-step', {
    agent: { session: { id: payload.sessionId }, meta: { id: 'orchdesk-main' } },
    messages: texts.map((t) => ({ source: { kind: 'user' }, content: [{ type: 'text', text: String(t) }] })),
    turn: payload.turn ?? 0,
    step: payload.step ?? 0,
  }, async () => ({ kind: 'enter', messages: [] }));
  return decision ?? null;
}

/** 关闭运行时（应用退出前调用，触发全部插件的逆效应）。 */
export async function stopRuntime(): Promise<void> {
  if (!runtime) return;
  // 退出前冲刷记忆（轮询间隔内的最后变更不丢）。
  if (memorySaveTimer) {
    clearInterval(memorySaveTimer);
    memorySaveTimer = null;
  }
  const memApi = memoryApiOf(runtime.ctx);
  if (memApi) persistMemoryNow(memApi);
  // Context 类型未声明 dispose；实际由 root fiber 提供（逆效应入口）。
  const disposable = runtime.ctx as unknown as { fiber?: { dispose?: () => Promise<void> | void } };
  try {
    await Promise.resolve(disposable.fiber?.dispose?.());
  } catch (err) {
    console.warn('[orchdesk] 运行时关闭异常:', (err as Error).message);
  }
  runtime = null;
}

// ---- helpers ----

/**
 * 原生动态 import。
 * 关键：本文件编译为 CJS，TS 会把静态写法的 `import()` 降级成 `require()`，
 * 而插件产物是 ESM —— require 直接失败。用 new Function 构造可绕过降级，
 * 保留真正的 ESM 动态加载（Node 22 / Electron 36 均支持）。
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;

/** 让 Cordis 的异步 fiber 状态机推进若干 tick。 */
function settle(times = 3): Promise<void> {
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)));
  return p;
}

/** 把绝对路径转成 file:// URL（Windows 盘符需三斜杠）。 */
function pathToFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}
