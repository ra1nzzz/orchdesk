// OrchDesk 桌面壳 bundle 入口（P0 占位）。
//
// 本 bundle 叠在 @deepseek-ai/dsh-base 之上（见 cordis.patch.yml）。
// P0 阶段无实质逻辑：仅导出桌面壳层标识，供 profile 合成与调试识别。
//
// P1（T-P1-1）将在此注册桌面壳桥接插件：
//   - 渲染进程经 contextBridge 访问 dsh ctx（会话创建 / 发消息 / 读事件流）；
//   - 系统托盘（打开主窗 / 退出）；
//   - 原生通知（任务完成）。
// P2 在此 insert 5 内置插件 rows（意图识别 / TRACE / 脑手解耦 / 多Agent编排 /
// OrchClaw Hub 延后）。

export const DESKTOP_BUNDLE_ID = '@orchdesk/dsh-desktop' as const;
export const DESKTOP_LAYER = 'desktop' as const;

/** 桌面壳层元数据：供 profile 合成图标注（与 dsh-base 的 agent 注释风格一致）。 */
export const desktopBundleMeta = {
  id: DESKTOP_BUNDLE_ID,
  layer: DESKTOP_LAYER,
  // 实际插件 rows 由 cordis.patch.yml 声明，profile composer 解析，不在此代码挂载。
} as const;
