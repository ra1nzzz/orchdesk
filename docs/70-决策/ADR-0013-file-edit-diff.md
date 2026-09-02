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
