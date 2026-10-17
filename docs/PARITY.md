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
| 多主机持久化 | 无（本地） | `core/HostStore.ts` | ✅ | 坑 15 修复的复测见待验第 23 条；**2026-10-17 真机**：同调试签名**覆盖安装**后 `wangke-PC` 配对数据**保住**（局域网 / 虚拟网两地址俱在） |
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
| Markdown 渲染 | 无（自研 `MarkdownLite`） | `core/MarkdownLite.ts` | ✅ | 标题/列表/引用/代码/GFM 表格/分隔线；表格列宽修复 2026-10-16 真机已验（待验第 24 条） |
| GenUI 卡片（`dsh-ui` 围栏） | 无（自研 `GenUiBlocks`） | `ui/GenUiCard.ets` | ✅ | 22 种组件，23 用例 |
| 工具调用详情 | 消息体 | `core/ToolCallDetail.ts` | ✅ | 18 用例 |
| 审批（含 `full-access` 二次确认） | `POST /approvals` | `ui/ChatDetail.ets` | ✅ | 由 `AlertDialog` 改为底部面板 + 勾选闸门 |
| AI 追问（ask） | 消息体 | `ui/ChatDetail.ets` | ✅ | 两道闸 |
| 上下文注入来源显示 | 消息体 | `ChatPresentation` | ✅ | 受设置 `showContext` 控制 |
| `@` 文件补全面板 | `GET /mention-entries` | `core/ComposerSuggestions.ts` + `ui/ComposerSuggestions.ets` | 🟡 | 待验第 18 条（三态文案、绝对路径是否被服务端认可） |
| `/` 命令补全面板 | `state.commands` | 同上 | ✅ | 2026-10-16 真机已验（待验第 25 条）：输入 `/` 即带出命令 |
| 会话配置面板（模型切换） | `sessionModels` | `ui/SessionConfigSheet.ets` | 🟡 | 待验第 21 条 |
| 双击复制 / 长按选择 | 无 | `ui/ChatMessage.ets` | 🟡 | 待验第 7 条（两者是否打架） |
| 自动跟随滚动 | 无 | `ui/ChatDetail.ets` | 🟡 | 待验第 8 条 |
| **滚动中冻结消息流** | 无（源：`ChatScrollFreeze.kt`） | `ui/ChatDetail.ets` | 🟡 | 2026-10-17 新增。停止滚动 80ms 后解冻；`setTimeout` 无取消 ⇒ 用代际号兜底（坑 30） |
| **消息时间戳** | 消息体 `time` | `core/ChatTimeLabel.ts` | ✅ | 2026-10-17 新增并**真机确认**（气泡内显示 `12:50` / `12:51`）。`time = 0` 表示「没有时间」，不显示 |
| **过程分组（工具 / 上下文 / 思考折叠）+ 组级耗时** | 消息体 | `core/ChatDisplayGroups.ts` + `ui/ProcessGroupRow.ets` | 🟡 | 2026-10-17 新增。只有 USER / ASSISTANT / FAILURE 打断分组；展开态必须住父组件（坑 29） |
| **代码块语法高亮（零依赖）** | 无（源：`ChatCodeHighlight.kt`） | `core/CodeHighlight.ts` + `ui/MarkdownView.ets` | 🟡 | 2026-10-17 新增。契约：分段拼接后**逐字符等于原文** |
| **表格边框 + 列间竖线** | 无（源：`ChatMarkdownTable.kt`） | `ui/MarkdownView.ets` | 🟡 | 2026-10-17 新增。原表格只有底色、没有边框，「不像一张表」 |
| **失败行重试** | 无（源：`TurnFailureRow`） | `ui/ChatMessage.ets` | 🟡 | 2026-10-17 新增 |
| **AI 生成内容标识（会话级常驻，与思考条合并）** | 无 | `ui/ChatStatusBar.ets` | ✅ | 1.0.2 已有标识；2026-10-17 与思考条合并成**一条状态条**（有思考显示思考、否则显示标识），并**真机确认**底部单条「内容由 AI 生成」在位。⚠️ 原 `ai-generated-label-evidence.png` 已过期，需重截 |
| **图片全屏查看 + 保存** | 消息附件 | `core/ImageSave.ts` + `ui/MessageParts.ets` + `ui/ChatDetail.ets` | 🟡 | 2026-10-17 新增。保存走**零权限系统面板**而不是写相册 —— 相册写入要 `WRITE_IMAGEVIDEO`（system_basic），声明会导致**安装失败**（坑 26）。取消与失败分档处理；文件名按魔数补扩展名 |
| **消息级分叉（`atSeq`）** | `POST /chat/sessions/{id}/fork` | `core/ChatFork.ts` + `ui/ChatMessage.ets` + `ui/ChatDetail.ets` | 🟡 | 2026-10-17 新增。只给**用户消息且 `seq > 0`**（源 `ChatForkPoint.kt` 判据）。分叉会真实新建会话 ⇒ 必须二次确认；确认框与展开态同理住父组件（坑 29） |
| **已归档会话入口** | `GET /chat/sessions?archived=true` | `ui/ArchivedSessionRow.ets` + `ui/ChatScreen.ets` | 🟡 | 2026-10-17 新增。**入口按能力位 `session-archive-list-v1` 守卫**，读不到能力位一律不显示（「未知 ≠ 缺失」，坑 33）—— 老 bridge 会忽略 `archived` 参数并返回未归档列表，照显示只会让用户以为「一条归档都没有」。底部**明说**本插件不支持恢复归档 |
| **执行统计面板** | 无（源：`ChatStats`） | `core/SessionStats.ts` + `ui/SessionStatsSheet.ets` | 🟡 | 2026-10-17 新增。会话头部菜单只读入口。**刻意不显示 Token 用量 / 上下文占用**（要内核提供、本仓读不到），面板底部**如实说明读不到所以不显示**；空会话显示「这个会话还没有可统计的事件」而不是一排 0 |
| **执行轨迹页** | 无（源：`ChatTrajectory`） | `core/Trajectory.ts` + `ui/TrajectoryScreen.ets` | 🟡 | 2026-10-17 新增。按 `turn` 分组、组内按 `seq` 排序。**不做类型过滤**：认不出的类型留 `OTHER` 并显示**事件类型原名**（不写笼统「其他」——「这到底是什么」正是排查时要看的）；组级耗时取不到可信值（时钟倒退 / 跨度为 0）就不印 |
| **事件断档检测 / 重连后 resync** | WebSocket `seq` + `chat.session.snapshot` | `core/ChatSeqMonitor.ts` + `HarnessViewModelConnection` | 🟡 | 2026-10-17 新增。**严格跳号才重拉整份历史**；重复与倒退算去重、**不算断档**（否则每次重连都白拉一遍）。基线 `cursor` 落后本地最大 seq 才刷新；序号序列**每会话独立** ⇒ `selectSession` 即清空 |
| **交付物实时出现（不刷新整页）** | `chat.deliverables.presented` | `HarnessViewModelConnection` | 🟡 | 2026-10-17 新增 |
| **连接即重放（重连成功即补拉错过的一切）** | WebSocket 重连 | `HarnessViewModelConnection.handleConnection` | 🟡 | 2026-10-17 新增（收口）。`connected = true` 时补拉当前会话历史 + 会话列表 + 待审批 + 待答问题 + 命令清单。**为什么必须显式重取**：WS 是「订阅之后才收得到」，断线窗口里的事件谁都管不着，而「卡片没弹」与「本来就没有待审批」在屏幕上长得一模一样；`resumeEvents`（熄屏恢复）复用同一条链 |

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
| **应用内字号缩放（0.8–1.5）** | 无（源：`AppPreferences.kt`） | `core/FontScale.ts` + `platform/Platform.ets` | ✅ | 2026-10-17 新增并**真机确认**（步进并落盘，`hdc` 直读偏好核对 `font_scale`）。**默认跟随系统**——擅自把用户调大的字号缩回去是更坏的行为 |
| **构建水印** | 无（源：`BuildConfig.BUILD_COMMIT`） | `core/BuildStamp.ets` | ✅ | 2026-10-17 新增并**真机确认**（设置页版本行副标题渲染提交号）。便于对着截图定位代码 |
| **主题三档（跟随系统 / 浅色 / 深色）** | 无（源：`data/InterfaceStyle`） | `core/ThemeMode.ts` + `ui/SettingsScreen.ets` + `platform/Platform.ets` | ✅ | 2026-10-17 新增（收口）并**真机确认**（点「深色」即时整页转深、重启仍 `dark`）。**存的是线上取值而不是枚举序数**（升级安全：源工程曾按 ordinal 存，升级后深浅色互换才改成存名字）；认不出的取值一律回落「跟随系统」；取值在 `ThemeMode` / 偏好 / 平台**三处都归一化** —— 原样传给 `setColorMode` 会在**点击回调**里抛参数错误（表现为「点一下就闪退」） |
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

## 统计（2026-10-17）

| 状态 | 项数 |
|---|---|
| ✅ 已实现并真机验证 | 28 |
| 🟡 已实现待真机验证 | 33 |
| 🔵 有意的差异 | 3 |
| ⛔ 不做 | 0 |

> **🟡 不等于"差"**，而是"等设备"。无设备时**不许**把 🟡 说成 ✅。
> 逐条复测方法见 `PORT-MAP.md` §7「待真机验证」（25 条）。
>
> 2026-10-17 的 **18 条新增项**（第 1 / 2 / 3 / 4 批移植补齐 + 收口）**已跑过编译与单测**
> （`BUILD SUCCESSFUL` + `684 用例全绿`，见 `STATUS.md` 文末）；其中 **6 条已上机确认**
> （消息时间戳、会话级状态条/AI 标识、构建水印、主题三档、应用内字号缩放、
> 覆盖安装后配对持久化）已由 🟡 升为 ✅，**其余仍为 🟡**（未逐条上机）。
>
> ✅ 计数**从 22 涨到 28**，是本轮真机验证后按**实测**升的（不是估算）：多主机持久化、
> 消息时间戳、AI 标识（会话级）、应用内字号缩放、构建水印、主题三档共 6 条 🟡 → ✅。
> 项数是**逐行数出来的**，每次往表里加行都要顺手重数一遍，别让统计与表格分家。
