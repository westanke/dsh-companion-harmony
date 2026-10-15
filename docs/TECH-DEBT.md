# 技术债务台账

> 台账不是豁免，**是债务**：每条都注明在哪一阶段清掉。
> **只许收紧**：条目对应的债务消失，同一提交里删掉该条目（自证非空转）。
> **上调必须带理由**：超过行数预算只许带理由在同一提交里上调，且必须在下一阶段拆回。
>
> 制度来源见 `AGENTS.md` §4；本文件为**手工台账，暂不进 CI**（ArkTS 侧无等价解析器）。
> 它回答的问题是「欠了多少、在往哪个方向走」，不是「谁违规了」。

## 行数预算

**当前预算：1 000 行/文件。** 基线测量日：**2026-10-15**（源文件，测试不计）。

> 预算由 800 上调至 1 000，理由：ArkTS 单文件承载能力高于 Kotlin——
> 泛型与接口表达能力更弱，同样逻辑需要更多样板（`@Observed` / `@Prop` 声明、
> `interface` 显式展开、规避继承覆盖歧义而采用的扁平判别式写法），
> 按 Kotlin 的 800 行卡会把正常的模块判成债。
> 上调后 `ui/GenUiCard.ets`(897)、`ui/ModelsScreen.ets`(865)、`core/DshClient.ts`(854)
> 退出在册，**在册数由 10 降至 7**。

| 文件 | 行数 | 为什么是债 | 清账阶段 |
|---|---|---|---|
| `core/HarnessViewModel.ts` | 3 345 | 连接 + 会话 + 文件 + 插件 + 模型 + 设置全在一个 ViewModel；会话页与它双向依赖。改一处要读 3 300 行 | 按域拆 `ConnectionViewModel` / `ChatViewModel` / `FilesViewModel` / `PluginsViewModel` |
| `ui/ChatDetail.ets` | 1 939 | 会话详情单文件承载：消息流、输入区、思考条、工具行、文件弹层、`@` 面板、手势分发 | 拆出 `ChatComposer` / `ChatTimeline` / `ChatSheets` 三个子组件 |
| `core/Models.ts` | 1 542 | 供应商与模型目录耦合在一个模块 | 拆 `ProviderModels` / `ModelCatalog` |
| `core/ChatPresentation.ts` | 1 456 | 会话呈现单一出口，职责正确但体量过大，事件族混在一处 | 按事件族拆（正文 / 思考 / 工具 / 上下文注入） |
| `ui/FilesScreen.ets` | 1 440 | 文件页承载：授权根、目录浏览、行号编辑器、Markdown 源码/预览、缩放、上传下载 | 拆出 `FileTreeView` / `FileEditorView` / `FilePreviewView` |
| `ui/ChatScreen.ets` | 1 125 | 会话列表 + 新建会话 + 工作区管理挤在一处 | 拆出 `SessionListView` / `NewSessionSheet` / `WorkspaceSheet` |
| `ui/ChatMessage.ets` | 1 099 | 消息渲染含 Markdown 块、表格、工具行、卡片分发 | 拆出 `MarkdownView` / `MarkdownTableView` / `ToolCallRow` |

> 这些是**已登记的债，不是许可**。新增超预算文件必须先入本表再写码。
>
> 退出在册的三个文件（`GenUiCard` / `ModelsScreen` / `DshClient`）仍是**待拆对象**，
> 只是未超新预算：`ModelsScreen` 与 `ModelSheet.ets` 职责重叠（865 + 511 行），
> `DshClient` 的 REST 与 WS 应分层，`GenUiCard` 的 22 种组件分发宜再拆。
> 它们移入下方「已知结构性债务」跟踪，避免"退出台账 = 一笔勾销"。

## 已知结构性债务

| ID | 债务 | 位置 | 为什么现在不动 | 清账条件 |
|---|---|---|---|---|
| DEBT-001 | 无文档一致性自动校验 | 全仓 | 源工程用 Gradle `docsCheck` 任务；ArkTS 侧无等价解析器，手写脚本性价比待评估 | 建立 `scripts/docs-check.sh` 校验 CHANGELOG / STATUS / 用例数一致 |
| DEBT-002 | 无 lint / 静态检查配置 | 仓库根 | 当前仅靠 `hvigorw` 构建与人工审查 | 引入 `code-linter` 配置后把新增告警当门禁 |
| DEBT-003 | 三个未超预算但职责重叠的文件 | `ui/ModelsScreen.ets`(865+`ModelSheet` 511)、`core/DshClient.ts`(854)、`ui/GenUiCard.ets`(897) | 预算上调后退出在册，但重叠与分层问题仍在 | 见 `docs/decisions/` 对应 ADR，随 1.1.0 拆解 |

## 账怎么记

- **新增**：写码前先入表，注明「为什么是债」与「清账阶段」。
- **清账**：同一提交里删条目 + 在 `docs/CHANGELOG.md` 记一条。
- **收紧**：行数下降时更新数字，不留旧值（旧值会骗人）。

> 判据不是「有没有债」——**债可见且方向向下，比假装没有债更可信。**
