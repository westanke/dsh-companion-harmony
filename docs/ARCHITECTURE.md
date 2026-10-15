# 架构

单 Ability ArkUI 应用。`HarnessViewModel` 持有连接、会话、文件、插件、模型与设置状态。
`DshClient` 是唯一网络边界，通过插件 `/api/v1` REST 与 WebSocket 工作；阻塞 IO 只在 worker 线程。

```
core/   ← 纯逻辑（可单测）：MarkdownLite / SecureConnectionStore / AppPreferences /
          ChatPresentation / ToolCallDetail / GenUiBlocks / SessionFileRefs ...
ui/     ← ArkUI 页面与组件，只消费 HarnessState、调 HarnessViewModel 动作
```

- ArkUI 表现层**不**自己发网络请求或直读偏好当状态（会导致「点了不动」）。
- 会话展示走 `ChatPresentation` 单一出口，只输出用户/助手正文、推理摘要、上下文注入来源、
  工具调用摘要；`step/end`、`turn/end`、token 序列与未知内部事件**不**渲染为聊天卡片。

助手正文先按 `dsh-ui` 围栏切成「文字段 + 卡片段」：文字走 `MarkdownLite` 块级切分
（标题 / 列表 / 引用 / 代码块 / GFM 表格 / 分隔线），卡片走 `GenUiBlocks` 原生组件树。
**不使用 WebView**——避免不可信文件在手机上取得执行权。

令牌由 `SecureConnectionStore` 加密保存（AES-GCM）；偏好只存非敏感项。
应用数据不参与云备份。

UI 依据设备 scope 禁用写入、删除和聊天提交；服务器仍是最终授权边界。
