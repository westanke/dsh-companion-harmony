# 能力对等矩阵

**对标对象**：Android 版 `dsh-companion`（本工程是它的 HarmonyOS 原生移植）。
**事实来源**：`PORT-MAP.md`（§1 工程结构、§7 已知缺口与待真机验证）。
**本文件回答的问题**：某项能力在本工程**有没有**、**差什么**、**为什么差**。

**状态图例**

| 标记 | 含义 |
|---|---|
| ✅ | 已实现，且已真机验证 |
| 🟡 | 已实现，**待真机验证**（单测与构建通过，但运行时行为未在设备上确认） |
| 🔵 | **有意的差异**（平台限制或刻意取舍，见"说明"列） |
| ⛔ | 不做（明确记录理由，不许沉默） |

---

## 1. 连接与配对

| 能力 | 插件 API / 依赖 | 本工程 | 状态 | 说明 |
|---|---|---|---|---|
| 配置导入（`DSH1:` 载荷） | 无（纯本地解析） | `core/ConnectionShare.ts` | ✅ | 15 用例 |
| 一次性配对码 | `POST /api/v1/pair` | `HarnessViewModel` | ✅ | |
| 多主机持久化 | 无（本地） | `core/HostStore.ts` | 🟡 | 坑 15 修复的复测见待验第 23 条 |
| 选路探活（四级排序） | `probes` | `core/ConnectionModels.ts` | ✅ | 排序键须与源一致，有单测锁 |
| 冷启动自动重连 + 自动切会话页 | `GET /scopes` | `AppRuntime` | 🟡 | 缺陷 C 修复，待验第 17 条 |
| 端点切换（局域网 / 虚拟网 / 公网） | 无 | `SettingsScreen` | 🟡 | 待验第 14 条 |
| 剪贴板读取 | ~~`READ_PASTEBOARD`~~ | — | 🔵 | 该权限为 `system_basic` 级，声明后**装不上**；已移除并降级为「读到空串则提示」 |
| `PATCH` 请求 | `SDK` 枚举缺 PATCH | `DshClient` | 🟡 | 靠字符串转型绕过，待验第 1 条 |

## 2. 会话

| 能力 | 插件 API / 依赖 | 本工程 | 状态 | 说明 |
|---|---|---|---|---|
| 会话列表 | `GET /sessions` | `ui/ChatScreen.ets` | ✅ | |
| 消息流（实时） | WebSocket | `core/ChatPresentation.ts` | ✅ | `step/end`、`turn/end`、token 序列**不**渲染为卡片 |
| Markdown 渲染 | 无（自研 `MarkdownLite`） | `core/MarkdownLite.ts` | 🟡 | 标题/列表/引用/代码/GFM 表格/分隔线；表格列宽修复待验第 24 条 |
| GenUI 卡片（`dsh-ui` 围栏） | 无（自研 `GenUiBlocks`） | `ui/GenUiCard.ets` | ✅ | 22 种组件，23 用例 |
| 工具调用详情 | 消息体 | `core/ToolCallDetail.ts` | ✅ | 18 用例 |
| 审批（含 `full-access` 二次确认） | `POST /approvals` | `ui/ChatDetail.ets` | ✅ | 由 `AlertDialog` 改为底部面板 + 勾选闸门 |
| AI 追问（ask） | 消息体 | `ui/ChatDetail.ets` | ✅ | 两道闸 |
| 上下文注入来源显示 | 消息体 | `ChatPresentation` | ✅ | 受设置 `showContext` 控制 |
| `@` 文件补全面板 | `GET /mention-entries` | `core/ComposerSuggestions.ts` + `ui/ComposerSuggestions.ets` | 🟡 | 待验第 18 条（三态文案、绝对路径是否被服务端认可） |
| `/` 命令补全面板 | `state.commands` | 同上 | 🟡 | 待验第 19 条 |
| 会话配置面板（模型切换） | `sessionModels` | `ui/SessionConfigSheet.ets` | 🟡 | 待验第 21 条 |
| 双击复制 / 长按选择 | 无 | `ui/ChatMessage.ets` | 🟡 | 待验第 7 条（两者是否打架） |
| 自动跟随滚动 | 无 | `ui/ChatDetail.ets` | 🟡 | 待验第 8 条 |

## 3. 文件

| 能力 | 插件 API / 依赖 | 本工程 | 状态 | 说明 |
|---|---|---|---|---|
| 授权根目录 | 插件 `scopes` | `ui/FilesScreen.ets` | ✅ | App 不拥有服务器绝对路径，只用 `rootId + relativePath` |
| 目录浏览 | `GET /files` | `ui/FilesScreen.ets` | ✅ | |
| 行号编辑器 | `PUT /files` | `ui/FilesScreen.ets`（`NumberedTextEditor`） | 🟡 | 待验第 9 条（行高对齐、超长单行折行） |
| Markdown 源码 / 预览 | 无 | `ui/FilesScreen.ets` | ✅ | 预览复用 `MarkdownView`，与聊天页同一份实现 |
| 图片预览 | `ImageCodec.ets` | `ui/FilesScreen.ets` | 🟡 | 待验第 5 条（格式兼容、长边 1024 内存） |
| 二进制降级预览 | 无 | `ui/Components.ets`（`BinaryFilePreview`） | ✅ | 会话文件表与文件页**共用**同一组件 |
| 下载 / 导出 | `documentPicker.save` | `Pickers.ets` | 🟡 | 待验第 11 条 |
| 打开目录（会话附件 → 文件分节） | 无 | `AppRuntime.requestFilesSection()` | 🟡 | 待验第 16 条 |
| 上传 | 系统选择器 | `Pickers.ets` | 🟡 | 待验第 4 条 |

## 4. 插件 / 模型 / 设置

| 能力 | 插件 API / 依赖 | 本工程 | 状态 | 说明 |
|---|---|---|---|---|
| 插件清单与档案 | `GET /plugins` | `ui/PluginsScreen.ets` | ✅ | |
| 插件启停 | `POST /plugins` | `ui/PluginsScreen.ets` | 🟡 | 待验第 15 条 |
| 供应商管理 | `GET/POST /providers` | `ui/ModelsScreen.ets` + `ModelSheet.ets` | 🟡 | 凭据**只读存在性与来源，不读正文** |
| 模型清单 | `GET /models` | `core/Models.ts` | 🟡 | 坑 14 修复：`@Prop` 选中态，待验第 21 条 |
| 发送方式 / 语言切换 | 无 | `ui/SettingsScreen.ets` | ✅ | 中文为主，英文接口已预留 |
| `showContext` / `genUiDebug` | 无 | 设置页 | ✅ | 分别被详情页与 `ChatMessageView` 真实读取 |
| `useWebChat` | 无 | 设置页 | 🔵 | **保留开关 + 页面显式说明**：本工程聊天页是 ArkUI 原生，无内置网页版，拨它看不出变化。刻意不隐藏 |

## 5. 平台与安全

| 能力 | 实现 | 状态 | 说明 |
|---|---|---|---|
| 时间 / UUID / 区域 / 时区 | `platform/Platform.ets` | ✅ | 唯一无法离线单测的一层 |
| 系统选择器 | `Pickers.ets` | 🟡 | 待验第 4 条 |
| 图片解码 | `ImageCodec.ets` | 🟡 | 待验第 5 条 |
| 外链打开 | `ExternalOpen.ets` | 🟡 | 待验第 6 条 |
| 抽屉手势 | `SideBarContainer` | 🟡 | 待验第 3 条 |
| 系统导航条随主题 | `onConfigurationUpdate` | 🟡 | 待验第 22 条 |
| 令牌加密存储（AES-GCM） | `core/SecureConnectionStore.ts` | ✅ | 不写日志 / 剪贴板 / 崩溃信息 |
| 不参与云备份 | 应用数据 | ✅ | 避免密文离开生成密钥的设备 |
| **不使用 WebView** | 全工程 | 🔵 | 见 `decisions/ADR-0001`：不可信文件不得取得执行权 |

---

## 统计（2026-10-15）

| 状态 | 项数 |
|---|---|
| ✅ 已实现并真机验证 | 20 |
| 🟡 已实现待真机验证 | 22 |
| 🔵 有意的差异 | 4 |
| ⛔ 不做 | 0 |

> **🟡 不等于"差"**，而是"等设备"。无设备时**不许**把 🟡 说成 ✅。
> 逐条复测方法见 `PORT-MAP.md` §7「待真机验证」（24 条）。
