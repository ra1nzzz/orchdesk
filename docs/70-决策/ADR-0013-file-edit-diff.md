# ADR-0013：文件 Tab 编辑与 diff（用户亲手写回，不走 Agent 授权门）

日期：2026-09-02 ｜ 状态：已采纳 ｜ 关联：ADR-0010、ADR-0012

## 背景

ADR-0012 把文件 Tab 定为「只读优先」，编辑 / diff 明确后置 P3「届时再议授权」。现在兑现。核心问题是：**文件编辑是谁的动作**——如果是用户在文件面板里亲手编辑保存，它与「浏览」同属用户自有操作；如果是 Agent 的 `file_write` 工具，那走既有授权门（另一条链路，不受本 ADR 影响）。

## 决策

1. **用户亲手编辑不走 Agent 授权门**（与 ADR-0012 浏览口径一致），但用四道防呆代替授权门——授权门防的是「Agent 乱写」，防呆防的是「用户误写」：
   - **外部修改检测（乐观并发）**：`file-read` 返回 `mtimeMs`，`file-write` 必带 `expectedMtimeMs`，主进程写前 stat 比对（2ms 容差），不符拒绝 `code='modified-externally'`，渲染层保留编辑缓冲并给「重新加载」按钮。防的是覆盖编辑器 / git / Agent 工具刚做的改动。
   - **不可编辑显式判定**：`editable` 由主进程统一判定（二进制 / 截断（只读前 2MB，保存会截断文件）/ 非 UTF-8（解出 U+FFFD，保存即乱码）→ `editable:false` + 渲染层给原因），渲染层不猜。
   - **写回原子性**：同目录临时文件 + rename，写一半崩溃不留半截文件。
   - **参数防呆前移**：`normalizeFileWrite`（纯逻辑）在入口拒绝二进制扩展名、超 2MB（与读取上限一致）、缺 `expectedMtimeMs`。
2. **diff = 编辑缓冲 vs 磁盘基线**，不做 git diff（文件面板不绑定 git 仓库）。实现为 **UMD-lite 单文件** `renderer/file-edit.js`（与 session-fork.js 同一约定：渲染层与 Node 验证套件跑同一份，零构建步骤）：
   - 行级 LCS（公共前后缀裁剪 + DP），输出带行号的扁平行序列；`groupHunks` 按 ±3 上下文分组（重叠自动合并）。
   - **EOL 保护**：textarea 赋值会把 CRLF 规范化成 LF——写盘前按原文件风格（`detectEol` / `applyEol`）还原，diff 也在还原后的文本上算（否则 CRLF 文件一进编辑器就是整文件假 diff）。
   - **规模上限显式降级**：任一侧 >5000 行或裁剪后 DP 超 4M 单元 → `tooLarge`，只给行数变化，不假装无差异。
3. **UI 状态机**：预览 → 编辑（textarea）→ 保存 / 放弃 / 对比。放弃（有未保存改动）用两段式确认（第一次点只 arm，3.5s 内再点才丢弃）；保存成功后预览基线轮转为新内容 + 新 mtimeMs，连续编辑不被自己的写入误伤。
4. **验证**：`file-edit-verify.cjs` 19 项进 verify 链——A 组 UMD diff 7 项（首跑当场抓出两个真 bug：回溯循环退出后剩余 add/del 行丢失、完全一致时返回全 ctx 行）、B 组 normalizeFileWrite 4 项、C 组 stub-electron 8 项（mtime 冲突拒绝、容差不误伤、连续编辑基线轮转、临时文件清理）。全量 verify 786→805（24 套件）。

## 后果

- 渲染层新增依赖：`file-edit.js`（<10KB，无外部包）。
- Agent 侧 `file_write` 工具链路不变（仍走授权门 + 白名单）。
- git diff / 编辑器级体验（CodeMirror merge）仍后置，待用户需求明确再议。

## 审阅后加固（2026-09-02，yt-dev-review 三方并行）

1. **EOL 多数派判定**：原 `detectEol` 是「见一个 `\r\n` 就判 CRLF」，混合行尾的文件会按少数派全量改写——产生肉眼不可见的整文件变更，而 diff 在规范化后的文本上算，用户连「我改了什么」都看不到。改为统计 CRLF/CR/LF 三种计数取多数派，并新增 CR-only 分支（老 Mac 风格）：判成 lf 会让 `applyEol` 把裸 `\r` 吃掉，保存时整个文件并成一行。
2. **encodingSuspicious 改成严格校验**：原判定是「解出的文本含 U+FFFD」，会把本来就合法含替代字符的文件误判成非 UTF-8（结果是可编辑的文件被禁掉编辑）。改用 `TextDecoder('utf-8', { fatal: true })`。
3. **shiki 体积门槛**：`codeToHtml` 同步阻塞渲染线程，实测 64KB=753ms、256KB=1.34s、1MB=5.1s、**2MB=10.5s**，HTML 膨胀约 6.8 倍（2MB 文本产出约 35 万 span）。超过 200KB / 3000 行一律回落 `<pre>`，并显式说明「文件过大，已跳过语法高亮以保证界面响应」——降级必须可见，且不影响编辑与保存。
4. **dirty 基线缓存**：原实现每敲一键都对 2MB 文本做 `applyEol` + 读整个 textarea（实测每次 1.1ms）。基线在 `startFileEdit` 算一次缓存，保存成功后随基线轮转一起更新。
5. **「未接入」判定修正**：文件面板原用 `typeof bridge.fileTree !== 'function'` 判未接入——桥兜底 stub 本身也是函数，永远命中不了，用户只看到「选择一个目录」（把「未接入」显示成「为空」）。改为宿主返回 `bridgeMissing` 标记驱动。

验证：file-edit 19→20 项，全量 verify 805→**814 项**（24 套件）。
