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
| **连接页三态（已连接 / 已断开 / 未参与）** | `GET /health` | `core/ConnectionLiveness.ts` + `ui/ConnectScreen.ets` | ✅（未上机） | 源 `ConnectionLiveness.kt`。`connected` 是历史状态位，不能当「此刻还连着」；回前台先复核、卡片红色「已断开」+「重新连接」、点按按 `shouldReconnectOnTap` 决定是否真发起。10 用例，见坑 60 |
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
| 工具调用详情 | 消息体 | `core/ChatToolFormat.ts`（+ `ChatToolItems.ts`） | ✅ | 18 用例 |
| **工具调用专用块（Read / Terminal / Diff）** | 消息体 | `core/ToolBlocks.ts` + `ui/ToolBlockBody.ets` | ✅（未上机） | 源 `a96f5e7`（v2.2.43）。`toolBlockView()` 把 `read`/`read_image`/`bash`/`edit`/`write` 投影成三种专用长相，其余回落 Generic；含 `extractReadBody()`（剥 `<content>`、判 `N: ` 行号）与 `stripAnsiEscapes()`（手写扫描，残缺序列不吞正文）。界面由 `ToolCallDetailBlock` 按形态分派（`read` 失败不走专用块、`diff` 失败补错误块）。19 用例 |
| **正文已知文件名链接化（已接入渲染路径）** | 会话文件清单 | `core/PathLinks.ts` + `core/InlineSegments.ts` + `ui/InlineText.ets` | ✅ | 源 `a344e3f`（v2.2.44）。`linkifyKnownFiles()`：唯一文件名才替换、不碰已有 Markdown 链接、只替换第一次；`inlineSegments()` 把 `[文字](目标)` 切成「普通文字 / 链接」分段，`InlineText`（`Text` + 逐段 `Span`）渲染；点击分流在 `ui/ChatDetail.ets`（服务端路径开文件面板并定位 / `http(s)` 外部浏览器 / 相对路径拼 cwd 再当绝对路径 / 其余提示不支持）。候选取自 `sessionFileList`（与「本会话的文件」面板**同一出处**）并跟随投影缓存。14 + 13 + 6 用例。链接目标末尾的位置后缀（`:12` / `:12-34` / `:12:5` / `#L12` / `#L12-L34`）在分类与拼 cwd 前剥掉（`stripLocationSuffix()`，2026-10-20 真机反馈修复）。见坑 46 / 坑 59 |
| **Markdown autolink 尖括号剥壳** | 无 | `core/ChatLinkTarget.ts` | ✅ | 源 `a344e3f`。`classify()` 先剥 `</abs/path>` 再分类，避免「翻倍路径」。4 用例 |
| **访问权限档位 Pill（顶栏胶囊）** | `GET /chat/permission-presets` + `POST` 命令 | `core/ModelsConfig.ts` + `core/DshClient.ts` + `ui/ChatHeader.ets` | ✅ | 源 `a96f5e7` / `a344e3f`（v2.2.43–44）。投影 `permissions` **只给 `currentValue`**，候选必须走独立目录接口（bridge ≥ 2.4.2；**老 bridge 404 须容忍**，见坑 47）；胶囊贴在顶栏「已连接 / 已断开」之后、**宽度自适应不独占一行**（源 `ChatHeader.kt` 同款位置），与 ⋯ 菜单权限段**同源**（`selectPermissionPreset` → `executeCommand(id, "/permission <preset>")`），`danger-full-access` 走二次确认；候选取不到时仍渲染**不可点**的档位标签。档位名走 `currentValue` → `preset` → `sandbox` 降级 |
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
| **回答被截断提示** | 实时帧 `chat.turn.end`（`reason.kind === 'max-tokens'`） | `core/ChatTruncation.ts` + `ui/MessageParts.ets` | ✅（未上机） | 源 `HarnessTruncationViewModel.kt` / `ChatModels.kt`。**不是失败**：`sessions.history` 不返回 `turn/end`，只能由实时帧写进状态（`truncatedNotice`，伪 seq=0），新一轮 `chat.turn.start` 清掉；历史侧另有 `turnEndItem` 的 `max-tokens` 分支兜底。渲染为黄色警示行（深浅各一套色），独立成消息、不折进过程组。9 用例 + 接线门禁 1 例。见坑 58 |
| **图片全屏查看 + 保存** | 消息附件 | `core/ImageSave.ts` + `ui/MessageParts.ets` + `ui/ChatDetail.ets` | 🟡 | 2026-10-17 新增。保存走**零权限系统面板**而不是写相册 —— 相册写入要 `WRITE_IMAGEVIDEO`（system_basic），声明会导致**安装失败**（坑 26）。取消与失败分档处理；文件名按魔数补扩展名 |
| **消息级分叉（`atSeq`）** | `POST /chat/sessions/{id}/fork` | `core/ChatFork.ts` + `ui/ChatMessage.ets` + `ui/ChatDetail.ets` | 🟡 | 2026-10-17 新增。只给**用户消息且 `seq > 0`**（源 `ChatForkPoint.kt` 判据）。分叉会真实新建会话 ⇒ 必须二次确认；确认框与展开态同理住父组件（坑 29） |
| **已归档会话入口** | `GET /chat/sessions?archived=true` | `ui/ArchivedSessionRow.ets` + `ui/ChatScreen.ets` | 🟡 | 2026-10-17 新增。**入口按能力位 `session-archive-list-v1` 守卫**，读不到能力位一律不显示（「未知 ≠ 缺失」，坑 33）—— 老 bridge 会忽略 `archived` 参数并返回未归档列表，照显示只会让用户以为「一条归档都没有」。底部**明说**本插件不支持恢复归档 |
| **执行统计面板** | 无（源：`ChatStats`） | `core/SessionStats.ts` + `ui/SessionStatsSheet.ets` | 🟡 | 2026-10-17 新增。会话头部菜单只读入口。**刻意不显示 Token 用量 / 上下文占用**（要内核提供、本仓读不到），面板底部**如实说明读不到所以不显示**；空会话显示「这个会话还没有可统计的事件」而不是一排 0 |
| **后台任务面板** | `GET/POST /chat/sessions/{id}/jobs…` | `core/JobViews.ts` + `core/HarnessViewModelJobs.ts` + `ui/JobsSheet.ets` | 🟡 | 2026-10-20 新增（源 `e609b04`，bridge ≥ 2.4.3）。会话 ⋯ 菜单入口，**按能力位 `job-list-v1` 守卫**（读不到能力位不显示 —— 老 bridge 上这条路由 404，显示了只会让人点进去看报错）。**补齐的是「长任务跑飞了只能干等」这个洞**：远程场景下能看清单、能终止、能按需读输出。三条判读口径都写进代码：`already-finished`（它已经结束了）≠ `requested`（已发送终止请求）、输出 `lossy` 亮明「不完整」、读失败不谎报「没有任务」。**v1 不实时推送**（REST 一帧 + 刷新按钮） |
| **执行轨迹页** | 无（源：`ChatTrajectory`） | `core/Trajectory.ts` + `ui/TrajectoryScreen.ets` | 🟡 | 2026-10-17 新增，2026-10-20 按真机反馈对齐呈现口径。按 `turn` 分组、组内按 `seq` 排序，**未知轮次永远垫底**。**过滤实现细节帧**（`step/start`、`step/end`、`turn/start`、`tool/result`、`session-log-*`、`agent/inbox/*`）—— 真机 265 个事件里近一半是噪音，不过滤时第一屏全是它们。类型名走本地化资源（用户消息 / 助手消息 / 工具调用 / 交付物 / 轮次结束），仅 `OTHER` 显示**事件类型原名**（「其他事件」不提供线索，「它到底叫什么」才是排查要的）；点节点展开缩进过的原始 JSON，无载荷显示「（这条事件没有载荷）」；组级耗时取不到可信值（时钟倒退 / 跨度为 0）就不印 |
| **事件断档检测 / 重连后 resync** | WebSocket `seq` + `chat.session.snapshot` | `core/ChatSeqMonitor.ts` + `HarnessViewModelConnection` | 🟡 | 2026-10-17 新增。**严格跳号才重拉整份历史**；重复与倒退算去重、**不算断档**（否则每次重连都白拉一遍）。基线 `cursor` 落后本地最大 seq 才刷新；序号序列**每会话独立** ⇒ `selectSession` 即清空 |
| **交付物实时出现（不刷新整页）** | `chat.deliverables.presented` | `HarnessViewModelConnection` | 🟡 | 2026-10-17 新增 |
| **连接即重放（重连成功即补拉错过的一切）** | WebSocket 重连 | `HarnessViewModelConnection.handleConnection` | 🟡 | 2026-10-17 新增（收口）。`connected = true` 时补拉当前会话历史 + 会话列表 + 待审批 + 待答问题 + 命令清单。**为什么必须显式重取**：WS 是「订阅之后才收得到」，断线窗口里的事件谁都管不着，而「卡片没弹」与「本来就没有待审批」在屏幕上长得一模一样；`resumeEvents`（熄屏恢复）复用同一条链 |

## 3. 文件

| 能力 | 插件 API / 依赖 | 本工程 | 状态 | 说明 |
|---|---|---|---|---|
| 授权根目录 | 插件 `scopes` | `ui/FilesScreen.ets` | ✅ | App 不拥有服务器绝对路径，只用 `rootId + relativePath` |
| 目录浏览 | `GET /files` | `ui/FilesScreen.ets` | ✅ | |
| 行号编辑器 | `PUT /files` | `ui/FilesScreen.ets`（`NumberedTextEditor`） | 🟡 | 待验第 9 条（行高对齐、超长单行折行） |
| **未保存改动确认** | 无（本地判据） | `core/HarnessTypes.ts`（`OpenDocument.hasUnsavedChanges`）+ `ui/EditorPane.ets` + `ui/FilesScreen.ets` | ✅（未上机） | 源 `FilesScreen.kt` / `UnsavedChangesDialog.kt`（v2.2.44 缺陷 W3）。打开时记原文并逐字比；保存键脏时变强调色；离开编辑器（顶栏 `←` 与系统返回键）走「保存 / 关闭 / 丢弃改动」三出口，存不了时保存键不亮。保存成功把基线挪到刚写进去的正文（否则永远判脏）。系统返回经 `AppStorage` 序号邮箱让入口页转请文件页弹面板（`onBackPress` 只能挂 `@Entry`）。6 用例，见坑 61 |
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

## 统计（2026-10-21 第四次重数）

| 状态 | 项数 |
|---|---|
| ✅ 已实现（其中 **4 行标注「未上机」**） | 34 |
| 🟡 已实现待真机验证 | 34 |
| 🔵 有意的差异 | 3 |
| ⛔ 不做 | 0 |

> 合计 **71 行**（2026-10-21 新增「连接页三态」「未保存改动确认」2 行，✅ 由 32 → 34；
> 两行都**标了「未上机」**，无设备时不改写成「真机通过」）。
>
> **🟡 不等于"差"**，而是"等设备"。无设备时**不许**把 🟡 说成 ✅。
> 逐条复测方法见 `PORT-MAP.md` §7「待真机验证」（25 条）。
>
> **2026-10-20 重数**：本表上一版（2026-10-17）是「28 / 33 / 3」，那一轮**漏数了此后新增的行** ——
> 「工具调用专用块」「正文已知文件名链接化」「访问权限档位 Pill」三行都是那次统计之后才进表的。
> 本轮**逐行重数**得 **31 / 33 / 3**（总行数 67）。加行请顺手重数，别让统计与表格分家。
>
> **2 行标的是 `✅（未上机）`**：工具调用专用块、回答被截断提示 —— 它们**只是代码落盘 +
> `BUILD SUCCESSFUL` + 单测通过**，**未在设备上确认**。按图例口径本应记 🟡；此处沿用
> 2026-10-20 给工具块定下的写法，把「已实现」与「已上机」两个维度**分开标注**，
> 计数时算进 ✅，**读表请以行内标注为准**。
>
> **2026-10-20 上机后重标**：**正文已知文件名链接化**与**访问权限档位 Pill** 两行已由「未上机」
> 升为 ✅（真机验收细节见 TESTING）。注意权限胶囊的**弹窗行点击**这一步受注入工具限制未单独触发
> —— `uitest uiInput click` 与 `uinput -T -c` 都驱动不了 ArkUI `bindMenu` 弹窗项（注入点击被
> 当作 dismiss 吞掉），属**工具局限、非代码缺陷**；该动作的 ⋯ 菜单路径已验通、与胶囊同源同值，
> 故不写成「全链路逐点已验」。
>
> 2026-10-17 的 **18 条新增项**（第 1 / 2 / 3 / 4 批移植补齐 + 收口）已跑过编译与单测；其中
> **6 条已上机确认**（消息时间戳、会话级状态条 / AI 标识、构建水印、主题三档、应用内字号缩放、
> 覆盖安装后配对持久化）已由 🟡 升为 ✅，**其余仍为 🟡**（未逐条上机）。
