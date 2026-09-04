# UI/UX 质量审查（impeccable /audit）

> **性质：仅审查。** 本文档只记录发现与建议，不代做修改。所有条目按 P0–P3 分级，
> 修复时按本文 Recommended Actions 的顺序走。
>
> 审查时间：2026-09-04 · 审查基线：commit `6447968`（待办语义化 + 侧栏重构后）
> 审查范围：`apps/desktop/renderer/`（app.js / styles.css / index.html）
> 工具方法：`impeccable` skill 的 `references/audit.md`（5 维度 · P0–P3 分级）

---

## Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | **1** / 4 | `--fg-faint` 浅色主题 2.33:1（AA 失败）；全项目 `tabindex` 0 处，div 交互元素键盘不可达 |
| 2 | Performance | **2** / 4 | `render()` 每次全量重建 side/main/context 三块 innerHTML（299KB 单文件无分包） |
| 3 | Theming | **3** / 4 | CSS 变量体系完整（20+ token），但 token 块外散落 6 处硬编码色 |
| 4 | Responsive Design | **2** / 4 | 0 个 media query，grid 固定 60/270/1fr/300px，无最小宽度保护 |
| 5 | Anti-Patterns | **3** / 4 | 无 AI slop 典型症状；主要问题是硬编码色与键盘可达性缺失 |
| **Total** | | **11 / 20** | **Acceptable（significant work needed）** |

**Rating bands**: 18-20 Excellent · 14-17 Good · 10-13 Acceptable · 6-9 Poor · 0-5 Critical

---

## Anti-Patterns Verdict

**通过 AI Slop Test。** 没有通用 AI 生成味的典型症状：

- 配色是**有意的克制**（VS Code 系深灰 + 单一 accent 蓝），不是「紫蓝渐变 + 玻璃拟态」模板；
- 没有无意义的阴影堆叠、圆角滥用、装饰性渐变；
- 字体栈用系统原生（`-apple-system / Segoe UI / Microsoft YaHei`），不追时髦字体；
- 空状态文案**具体**（「让 Agent 先输出计划清单…即可在此跟踪」），不是空洞的「暂无数据」。

真实的问题是工程性的（硬编码色、键盘可达性、重绘粒度），不是审美性的。

---

## Executive Summary

- **Audit Health Score: 11/20（Acceptable）**
- **问题分布**：P0 × 0 · P1 × 2 · P2 × 3 · P3 × 2
- **Top 3 关键问题**
  1. **P1** `--fg-faint` 在浅色主题下对比度仅 **2.33:1**（AA 要求 4.5:1），而它被 67 处 10–11px 小字使用
  2. **P1** 全项目 **0 处 `tabindex`**，新增的侧栏交互元素（文件树行、浏览器 TAB 卡片）纯键盘无法操作
  3. **P2** `render()` 全量重绘三块 innerHTML，工具步骤推送（150ms 节流）期间反复重建整个侧栏与右栏
- **下一步**：先修两个 P1（对比度是全局 token 改动，性价比最高；键盘可达性按「div 交互元素统一补 role/tabindex」一次性收敛）

---

## Detailed Findings by Severity

### [P1] 次要文字对比度不达 WCAG AA

- **Location**: `styles.css:6`（dark `--fg-faint: #6B7280`）、`styles.css:16`（light `--fg-faint: #9CA3AF`）
- **Category**: Accessibility / Theming
- **Impact**: 实测对比度 ——

  | 组合 | 对比度 | AA(4.5:1) |
  |------|--------|-----------|
  | light `--fg-faint` on `--bg` #FFFFFF | **2.54:1** | ✗ FAIL |
  | light `--fg-faint` on `--bg-panel` #F5F5F4 | **2.33:1** | ✗ FAIL |
  | dark `--fg-faint` on `--bg` #1E1E1E | **3.45:1** | ⚠ 仅大字 |
  | dark `--fg-faint` on `--bg-panel` #252526 | **3.17:1** | ⚠ 仅大字 |
  | dark `--fg-dim` on `--bg` | 6.57:1 | ✓ |
  | light `--fg-dim` on `--bg` | 4.83:1 | ✓ |

  该色承载了 67 处 10–11px 辅助文字（时间戳、路径、说明、页脚提示），小字号 + 低对比度叠加，
  浅色主题下接近不可读。
- **WCAG**: 1.4.3 Contrast (Minimum) — AA 要求正文 ≥ 4.5:1
- **Recommendation**:
  - light `--fg-faint`: `#9CA3AF` → `#6B7280`（约 4.83:1，与 `--fg-dim` 同档时可考虑合并语义）
  - dark `--fg-faint`: `#6B7280` → `#7C8595`（约 4.6:1）
  - 若视觉上「次要文字」层级因此消失，改用**字号/字重**区分层级，而不是靠低对比度
- **Suggested command**: `/colorize`

### [P1] 键盘不可达：div 交互元素缺 role / tabindex

- **Location**: `app.js` 全项目；本轮新增 `app.js:2448`（`.bw-tab` 浏览器 TAB 卡片）、`app.js` `ftab-row`（文件树行）
- **Category**: Accessibility
- **Impact**: 纯键盘/读屏用户无法操作文件树、浏览器页面卡片等核心侧栏功能。
  项目既有模式是 `div + data-action`，早先为 `.sess` / `.proj-head` 补过 `focus-visible`，
  但 `tabindex` 全项目为 **0** —— 焦点样式存在却没有焦点可达，等于半截工程。
- **WCAG**: 2.1.1 Keyboard（A 级）
- **Recommendation**（二选一，推荐后者一次性收敛）：
  1. 逐个给交互 div 补 `role="button" tabindex="0"` + Enter/Space 键盘处理；
  2. **更稳的做法**：在事件委托层统一处理 —— 渲染后遍历 `[data-action]:not(button)`，
     自动补 `role="button" tabindex="0"`，并在全局 keydown 上把 Enter/Space 映射到 click。
     这样新加元素自动继承，不会下次又漏。
- **Suggested command**: `/harden`

### [P2] `.term-body` 在浅色主题下仍硬编码深色

- **Location**: `styles.css:596-597`
  ```css
  .term-body{...background:#161622...}
  [data-theme="light"] .term-body{background:#161622}   /* 明写了也不跟随主题 */
  ```
- **Category**: Theming
- **Impact**: 浅色主题下终端是一块深色矩形，破坏 token 体系的一致性；
  若这是**有意的**（终端仿真器惯例用深色），应当落成显式 token（如 `--term-bg`），
  而不是在 light 分支里重复硬编码同一个值——后人无法判断这是「忘了改」还是「刻意如此」。
- **Recommendation**: 新增 `--term-bg`（dark/light 各给值），或明确注释「终端刻意保持深色，勿随主题切换」。
- **Suggested command**: `/normalize`

### [P2] `render()` 全量重绘三块 innerHTML

- **Location**: `app.js` `render()`（重绘 `#side` / `#main` / `#context`）
- **Category**: Performance
- **Impact**: Agent 执行工具时每步推送都触发 `render()`（150ms 尾随节流），
  每次都把侧栏会话树、右栏三个 TAB 的内容连同主区一起重建。会话长、文件树大时可见卡顿，
  且重建会丢失文本选区与滚动位置。
- **Recommendation**: 分流重绘 —— typing / 工具步骤推送期只更新主区消息流，
  侧栏与右栏改用「脏标记」在回合结束时补一次重绘。
- **Suggested command**: `/optimize`

### [P2] token 块外散落 6 处硬编码色

- **Location**: `styles.css:596, 597, 611, 646, 655, 657, 660`
  （`#161622` ×2、`#e6e6f0`、`#e5484d` ×2、`#3fb950`、`#d29922`）
- **Category**: Theming / Anti-Pattern
- **Impact**: `--danger` 等 token 已存在，diff 与 badge 却另起一套色值，主题切换时可能不同步。
- **Recommendation**: 收敛进 token；diff 增/删色若需区别于语义色，也应是 `--diff-add` / `--diff-del` 显式 token。
- **Suggested command**: `/normalize`

### [P3] 无响应式断点 / 无最小宽度保护

- **Location**: `styles.css:42-43`（`.app` grid 固定 `60px 270px 1fr 300px`）
- **Category**: Responsive Design
- **Impact**: 桌面应用可辩护，但窗口收窄到 ~900px 以下时主区被两侧栏挤扁；
  本轮新增的浏览器侧栏与终端抽屉进一步压缩主区高度。
- **Recommendation**: 给 `body` 设 `min-width`，或加窄窗口断点自动折叠侧栏（保留 rail）。
- **Suggested command**: `/adapt`

### [P3] 10–11px 小字过多（67 处）

- **Location**: `app.js` 内联样式与 `styles.css` 多处
- **Category**: Accessibility / Anti-Pattern
- **Impact**: 与 P1 的低对比度叠加后可读性进一步恶化。
- **Recommendation**: 正文不低于 11px；辅助信息不低于 10.5px 且必须满足 4.5:1。
- **Suggested command**: `/typeset`

---

## Patterns & Systemic Issues

1. **`div + data-action` 模式缺少统一的无障碍兜底** —— 不是某几个元素漏了，
   而是这套模式本身没有在框架层补 `role`/`tabindex`/键盘事件。逐个补会持续漏，
   应当在事件委托层一次性解决（见 P1-2 方案 2）。
2. **「次要信息 = 更淡的颜色」成为默认手段** —— 层级区分过度依赖对比度，
   而不是字号/字重/间距。这是对比度不达标的根因，改个别色值只能缓解。
3. **token 体系建了但没有强制力** —— 21 处硬编码色里 15 处在 token 定义块内（合理），
   6 处在块外（破口）。缺一条「新增颜色必须先建 token」的约束或 lint。

---

## Positive Findings

- **主题体系完整**：20+ CSS 变量覆盖 dark/light，切换集中在 `:root` 与 `[data-theme="light"]` 两处。
- **焦点样式已起步**：`styles.css:36-37` 为 button / navbtn / sess / proj-head 等建立了 `focus-visible` 轮廓。
- **降级可见性原则贯彻得好**（跨模块一致）：终端管道模式标注 `via`、node-pty 不可用显式徽标、
  浏览器「未接入主进程」与「已接入但为空」分开表达、文件 TAB「未绑定目录」不冒充空目录。
  这类诚实标注比视觉打磨更影响信任，值得保持。
- **空状态文案具体且可执行**：告诉用户下一步做什么，而不是「暂无数据」。
- **无 AI slop**：配色克制、无渐变/阴影滥用、字体栈系统原生。

---

## Recommended Actions

1. **`/colorize`** — 修 `--fg-faint` 双主题对比度（P1，全局 token 改动，收益面最大）
2. **`/harden`** — 在事件委托层为 `div[data-action]` 统一补 `role="button" tabindex="0"` + Enter/Space（P1）
3. **`/normalize`** — 把 6 处 token 块外硬编码色收敛成显式 token，含 `--term-bg`（P2）
4. **`/optimize`** — `render()` 分流重绘：typing 期间只更主区，侧栏/右栏走脏标记（P2）
5. **`/adapt`** — 加 `min-width` 保护与窄窗口折叠策略（P3）
6. **`/typeset`** — 清理 67 处 10–11px 小字，建立字号下限（P3，建议在 P1 之后做）

> 顺序说明：1 → 2 是 P1，应优先；3–4 是 P2，可与 1–2 同批；5–6 是打磨项。
> 做完 1–4 后重跑 `/audit`，预期总分可达 15–17（Good）。
