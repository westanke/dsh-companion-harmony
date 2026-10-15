# ADR-0001：聊天页用 ArkUI 原生重写，不用 WebView

- 状态：已采纳
- 日期：2026-10-15

## 背景

源工程（Android）的会话界面是 Compose 原生实现，但服务端 `dsh-remote-bridge` 自带一个
`--profile web` 的 WebUI。移植到 HarmonyOS 时有两条路：

1. 用 `Web` 组件直接加载服务端 WebUI（省事，界面立刻"对等"）；
2. 用 ArkUI 原生重写会话页（工作量大，且需要自己实现 Markdown / GenUI 渲染）。

## 决策

**聊天页用 ArkUI 原生重写，全工程不使用 WebView。**

## 理由

1. **安全**：会话里会出现不可信内容——工具调用回显的代码、用户工作区里的 HTML 文件。
   走 WebView 意味着这些内容与 WebUI 同处一个 JavaScript 上下文，取得执行权。
   原生渲染没有这个面。
2. **交互一致性**：源工程在手机端已针对窄屏做过交互重塑（底部面板、药丸输入框、抽屉），
   直接套 WebUI 会把这些设计全部丢掉。
3. **离线可测**：原生渲染的判据（`MarkdownLite` / `GenUiBlocks` / `ChatPresentation`）
   是纯函数，可以在电脑上跑单测；WebView 路径下大部分逻辑只能靠真机肉眼看。

## 后果

- **代价**：需要自研 Markdown 解析与 GenUI 渲染——这是本工程最大的两块自研代码，
  并直接导致 `ui/ChatMessage.ets`、`ui/GenUiCard.ets` 成为待拆对象（见 `TECH-DEBT.md`）。
- **代价**：设置页的 `useWebChat` 开关在本工程无实际作用，
  处理方式是**保留开关 + 页面显式说明**，而不是隐藏（见 ADR-0006 的"不许沉默"同款原则）。
- **收益**：`ui/` 与 `core/` 的边界干净——渲染层没有网络与权限决策，可在电脑上离线验证。
