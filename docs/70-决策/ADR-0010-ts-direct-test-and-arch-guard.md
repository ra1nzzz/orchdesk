# ADR-0010：TypeScript 直测 loader 与架构守护测试

日期：2026-09-01 ｜ 状态：已采纳 ｜ 关联：lencx/Minke 借鉴分析、CHECKPOINT v0.12.0 第十一段

## 背景

`lencx/Minke` 是同底座（DeepSeek Harness）的同类桌面工作台。2026-09-01 的三路并行分析结论中，最值钱的不是功能，而是两条工程纪律（详见临时目录分析报告）：

1. **`node --test` 直跑 TS/TSX** —— 测试直接 import 主进程源码，不存在「编译产物」这一层间接；
2. **架构约束由测试守护** —— `module-boundaries` 扫 import 图，并内嵌 `knownViolation` 正样本自检，防止规则本身静默失效。

对照 OrchDesk 现状，两处都是真缺口：

- 18 个验证套件一律 `require('dist/*.js')`，即「先 `tsc` 再测」。**2026-08-31 已踩坑**：改了插件源码忘了 `tsc` + `vendor-dsh`，套件用旧产物跑出假失败/假通过。这条纪律当时只写进了记忆（人肉遵守），没有机器守护。
- 架构铁律（渲染层禁 `require`、纯逻辑模块零 electron 依赖、持久化与工具执行只在主进程）此前**只存在于 ADR 与人脑中**，没有任何自动化检查——破坏它是静默的，review 也未必看得见。

## 决策

1. **零依赖 TS 直测 loader**（`apps/desktop/scripts/ts-loader-hooks.mjs` + `ts-load.cjs`）
   - 基于 Node 22.13+ 内置的 `module.stripTypeScriptTypes()`（amaro/swc）与 ESM `module.register()` hooks，**不引入 esbuild / ts-node 等任何新依赖**。
   - 只接管 `.ts`：resolve 阶段补扩展名（`./credentials` → `credentials.ts`，`./x.js` → `x.ts`），load 阶段剥类型后以 `format:'module'` 返回。**不碰 CJS `require()` 链**——现有「stub electron + require dist/main.js」的 IPC 驱动套件完全不受牵连（有回归测试守护）。
   - 验证套件用 `await importTs('session-events.ts')` 直接测源码。
2. **与 dist 产物的一致性是硬约束**（`ts-loader-verify.cjs` B 组）：同一输入下 TS 版与 dist 版输出必须逐 JSON 相等。否则说明 loader 引入语义漂移，直测结果不可信。
3. **架构守护测试**（`arch-guard-verify.cjs`），规则表 + 元规则自检：
   - R1 渲染层禁 Node/Electron 直连；R2 纯逻辑模块零 electron 依赖；R3 纯逻辑不得依赖宿主层；R4 渲染层不得持久化/执行工具；R5 源码禁硬编码本机路径与密钥形态；R6 插件产物链路不陈旧（src → lib → vendor）；R7 每个验证套件都必须在 `package.json` verify 链上。
   - **M1 每条规则必须命中自己的正样本**（抓不到 = 规则失效，FAIL）；M2 规则扫描面非空（glob 写错 = 规则空转，FAIL）；M3 白名单文件必须存在；M4 白名单确实零 electron。
   - 扫描前剥离块注释与整行 `//`，避免注释里的示例代码误报。
4. **陈旧产物即失败**：`.ts` 比 `dist/*.js` 新、或插件 `src` 比 `lib` 新、`lib` 比 `vendor` 新，一律 FAIL 并在消息里给出修复命令。宁可让开发流程红一次，也不要让旧产物冒充通过。

## 理由

- **为什么要机器守护而不是继续靠记忆**：已踩过的坑证明人肉纪律会失效，而这类失效的表现是「测试通过、生产坏」——最难发现的一类。
- **为什么零依赖**：Node 内置能力已足够。引入 esbuild 只是把安装失败与供应链风险换成一点便利，而 strip-types 对本项目源码（无 enum / namespace / 参数属性 / 装饰器）完全够用。
- **为什么规则要配正样本自检**：架构规则是「否定式断言」，一旦正则被误改成永假或扫描面变空，它会**静默通过**——比没有规则更危险（会给人虚假的安全感）。Minke 的 `knownViolation` 正是防这个。
- **为什么不做全量迁移到 TS 直测**：现有 18 个套件跑得好好的，一次性替换风险大于收益。loader 是能力供给，B 组一致性测试保证它与 dist 语义等价；后续新套件优先用 `importTs`，存量套件按需迁移。

## 后果

- 正向：改源码立刻反映到断言（无需 `tsc`）；四条铁律有了机器守护；插件「忘了 tsc/vendor」的坑被 mtime 探针提前拦下。
- 代价：Node 22.13+ 成为验证链路的硬要求（打包与运行不受影响；CI 需锁 Node ≥ 22.13）。ESM 缓存意味着同 URL 二次 import 命中缓存——需重新加载时用 `?t=N` cache-busting 后缀（loader 已支持）。
- 边界：loader 只用于**测试**，不进入打包产物（`build.files` 不含 `scripts/ts-loader-*`）；生产运行仍走 `dist/*.js`。
