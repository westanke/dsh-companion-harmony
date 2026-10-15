# 变更日志

本文件记录 DSH 伴侣（HarmonyOS 原生版）的所有重要变更。

- 格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)
- 版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)
- 分组名称与 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)
  的类型对应：新增 `feat` / 变更 `refactor` / 修复 `fix` / 移除 `remove` / 文档 `docs`

## 写入约定

1. **每一次改动都在此追加**，不允许只改代码不记文档。
2. 尚未发版的改动先写进 `## [未发布]` 段；发版时把该段整体挪到对应版本号下并补日期。
3. 条目要写清**为什么**，而不只是**改了什么** —— 本工程是 Android → HarmonyOS 的移植，
   很多改动的理由来自平台差异，不写理由后来者会重复踩坑。
4. 移植过程中的逐模块对照与具体坑点另见 [PORT-MAP.md](./PORT-MAP.md)；
   本文件只记**面向版本**的变更，不重复其模块级细节。

---

## [未发布]

### 文档

- 纳入 git 管理：`git init` + 首笔提交，提交信息遵循
  [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)；
  `.gitignore` 保持 `signing/` 整体忽略（私钥绝不入库），`oh-package-lock.json` 改入版本库。
- 新增 [README.md](../README.md)：项目简介、构建 / 签名 / 测试命令、工程结构、文档索引。
- [PORT-MAP.md](./PORT-MAP.md) 补记本轮遗漏项：坑 23（表格列宽折断英文词）、收尾六
  （正式发布与上架：`.hap` / `.app` 双签、发布签名材料、图标改造、上架材料、git 管理）、
  待真机验证第 24 条；并修正坑 22 里过时的西文系数（0.55 → 0.60）与「README 尚未写」条目。
- §1 工程结构树里 `AppRuntime.ets` 的「跨分节导航请求」表述偏宽 —— 实际只有
  `requestFilesSection()` 一个、且仅通向文件分节，改为「跨分节跳转请求（当前仅文件分节）」。
- 学习源工程 `dsh-companion` 的一线项目文档标准，落地 7 份文档：
  `AGENTS.md`（工程宪法）、`docs/README.md`（索引）、`docs/STATUS.md`（当前状态）、
  `docs/ARCHITECTURE.md`（架构）、`docs/RELEASE.md`（发版流程）、`docs/TESTING.md`（测试）、
  `docs/SECURITY.md`（安全）；根 `README.md` 文档索引同步更新。
- 引入债务台账制度：新增 `docs/TECH-DEBT.md`，行数预算 **800 行/文件**，按 2026-10-15
  基线登记 **10 个超预算文件**（最大 `core/HarnessViewModel.ts` 3 345 行）与 2 条结构性债务；
  `AGENTS.md` §4.2 立制、§8 同步，`docs/README.md` 挂索引。
- 行数预算由 800 **上调至 1 000**（理由：ArkTS 样板多于 Kotlin），在册文件 **10 → 7**；
  退出的 3 个文件（`GenUiCard` / `ModelsScreen` / `DshClient`）转入新增的 `DEBT-003` 继续跟踪。
- 补齐源工程文档体系的其余四类：
  - `docs/PARITY.md` 能力对等矩阵（✅/🟡/🔵/⛔ 四态，20 项已验 / 22 项待验 / 4 项有意差异）
  - `docs/ROADMAP.md` 任务台账（阶段、进行中、1.0.1 / 1.1.0 拆债、待办池）
  - `docs/decisions/` 架构决策记录（索引 + 6 条 ADR，其中 **ADR-0005 记录了一次被推翻的决策**：
    Markdown 表格从「刻意不解析」改为「解析并原生渲染」，前案原文保留）
  - `artifacts/RELEASE_NOTES_v1.0.0.md` 发版说明（面向用户与审核）

---

## [1.0.0] - 2026-10-15

首个正式版，也是 Android 版 DSH Companion 到 HarmonyOS（ArkTS / ArkUI）的完整移植。

### 新增

**功能模块（移植主体）**
- 连接管理：局域网 / 虚拟网 / 公网多地址并存与切换，配置导入与一次性配对码
- 会话：列表、详情、实时消息流、AI 思考过程、工具调用记录与待审批交互
- 工作区文件：浏览与编辑、会话内文件预览（HTML 结构预览、二进制降级）
- 模型与插件：供应商管理、会话模型切换、插件清单与启停
- 界面偏好：深色模式跟随系统主题、中文界面并预留英文接口
- 聊天页为 ArkUI 原生重写，不使用 WebView

**Markdown 渲染（会话正文）**
- 新增 GFM 表格解析与渲染：`MdBlockKind.TABLE` 块、`MdTable` 载体，列宽按内容估算
  （`markdownTableColumnWidths`），界面套横向 `Scroll` 兜住超宽表格。移植前表格整块
  退化成裸竖线文本，比窄表格更难读 —— 这是移植期口径的修正（早期版本刻意不画表格）。
- 新增分隔线（`MdBlockKind.HR`）解析与渲染。
- 行内标记补齐链接、图片、删除线与星号斜体；**刻意不认下划线系** —— `a_b_c`、
  `__init__` 这类会被正则吃坏，判断不出词边界。

**打包与发布**
- 产出 release 正式包，含 `.hap`（模块包，真机安装）与 `.app`（App Pack，上架用）。
- `.app` 采用**里外双签**：先签内部 `entry-default.hap`，组装后再签外层 `.app`。
  只签外层时内部 hap 签名缺失（`signature not found`），上架有被拒风险。
- 上架文案 [store-listing.md](./store-listing.md)：中英文各一份，含一句话简介与应用介绍。
- 应用介绍截图 6 张（1080×1920，9:16），见 `docs/screenshots/`。

**应用图标**
- 图标加入 `DSH` 字样以区别于其他产品，并同步进包内 4 处（`AppScope` 与 `entry`
  各自的 `app_icon.png`、`startIcon.png`）。
- 另出平台图标（1024×1024 PNG）供 AGC 使用；与包内图标同源、几何一致。

### 变更

- `SessionConfigSheet` 改为自订阅 `@StorageLink('dshRevision')` 并取 `cfg()` 快照，
  不再依赖父组件透传 `config` —— 父组件漏传时面板会显示旧值。
- 配置面板高度改用 `SheetSize.FIT_CONTENT`，消除底部大片留白。
- 表格列宽估算的字号来源统一：表头与正文**分别估算再取大**
  （`markdownTableColumnWidths` 新增 `headerFontSizeVp` 参数），渲染与估算共用
  `ChatMessage.headerCellSize()` 这一个出处。原先把表头字号硬编码在渲染处、估算按
  正文字号算，两处各写各的，长表头必然偏窄。
- 西文字宽系数由 0.55 提到 0.60，表格列宽普遍加宽约 9%（宁可略宽，也不让单词被折断）。

### 修复

- **模型列表中点击模型无响应**：`ModelRowView.selected` 与 `AgentPresetRow.selected` /
  `rowEnabled` 由普通成员改为 `@Prop`。`ForEach` 的键不含选中态，键不变则复用组件
  实例，普通成员永远停在首次渲染值。
- **会话详情侧滑 / 返回键直接退出应用**：`Index.onBackPress` 改为退回会话列表。
- **表格里的长英文标识符被在词内折断**（真机表现为 `bundleNam` / `e`）：西文字宽系数
  原为 0.55，与系统比例字体的实际字宽（0.55~0.58 em）贴边，估出的列宽恰好比渲染宽度
  窄几个像素，`Text` 便在词内强制断开。
- 表格块的 `ForEach` 键改为编入表头与各行文字 —— 原键只含长度，而表格块的 `text` 恒为
  空串，流式更新期间键不变，表格一直停在第一帧。

### 移除

- 调试期取证日志：`ModelSheet` 2 处、`HarnessViewModel.selectModel` 1 处。
- 已被正式包取代的 debug 构建包。

---

## 版本对应

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.0.0 | 2026-10-15 | 首个正式版 |
