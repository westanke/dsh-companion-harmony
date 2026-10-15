# 技术债务台账

> 台账不是豁免，**是债务**：每条都注明在哪一阶段清掉。
> **只许收紧**：条目对应的债务消失，同一提交里删掉该条目（自证非空转）。
> **上调必须带理由**：超过行数预算只许带理由在同一提交里上调，且必须在下一阶段拆回。
>
> 制度来源见 `AGENTS.md` §4；本文件为**手工台账，暂不进 CI**（ArkTS 侧无等价解析器）。
> 它回答的问题是「欠了多少、在往哪个方向走」，不是「谁违规了」。

## 行数预算

**当前预算：800 行/文件。** 基线测量日：**2026-10-15**（源文件，测试不计）。

| 文件 | 行数 | 为什么是债 | 清账阶段 |
|---|---|---|---|
| `core/HarnessViewModel.ts` | 3 345 | 连接 + 会话 + 文件 + 插件 + 模型 + 设置全在一个 ViewModel；会话页与它双向依赖。改一处要读 3 300 行 | 按域拆 `ConnectionViewModel` / `ChatViewModel` / `FilesViewModel` / `PluginsViewModel` |
| `ui/ChatDetail.ets` | 1 939 | 会话详情单文件承载：消息流、输入区、思考条、工具行、文件弹层、`@` 面板、手势分发 | 拆出 `ChatComposer` / `ChatTimeline` / `ChatSheets` 三个子组件 |
| `core/Models.ts` | 1 542 | 供应商与模型目录耦合在一个模块 | 拆 `ProviderModels` / `ModelCatalog` |
| `core/ChatPresentation.ts` | 1 456 | 会话呈现单一出口，职责正确但体量过大，事件族混在一处 | 按事件族拆（正文 / 思考 / 工具 / 上下文注入） |
| `ui/FilesScreen.ets` | 1 440 | 文件页承载：授权根、目录浏览、行号编辑器、Markdown 源码/预览、缩放、上传下载 | 拆出 `FileTreeView` / `FileEditorView` / `FilePreviewView` |
| `ui/ChatScreen.ets` | 1 125 | 会话列表 + 新建会话 + 工作区管理挤在一处 | 拆出 `SessionListView` / `NewSessionSheet` / `WorkspaceSheet` |
| `ui/ChatMessage.ets` | 1 099 | 消息渲染含 Markdown 块、表格、工具行、卡片分发 | 拆出 `MarkdownView` / `MarkdownTableView` / `ToolCallRow` |
| `ui/GenUiCard.ets` | 897 | 22 种 dsh-ui 组件的分发与渲染集中一处 | 按组件族拆分文件 |
| `ui/ModelsScreen.ets` | 865 | 模型页与 `ModelSheet.ets`（511 行）职责有重叠 | 与 `ModelSheet` 合并去重后再评估 |
| `core/DshClient.ts` | 854 | **唯一网络边界**，职责上不该拆散；但 REST 与 WS 需分层 | 拆 `DshRestClient` / `DshEventStream`，保持单一出口语义 |

> 这些是**已登记的债，不是许可**。新增超预算文件必须先入本表再写码。

## 已知结构性债务

| ID | 债务 | 位置 | 为什么现在不动 | 清账条件 |
|---|---|---|---|---|
| DEBT-001 | 无文档一致性自动校验 | 全仓 | 源工程用 Gradle `docsCheck` 任务；ArkTS 侧无等价解析器，手写脚本性价比待评估 | 建立 `scripts/docs-check.sh` 校验 CHANGELOG / STATUS / 用例数一致 |
| DEBT-002 | 无 lint / 静态检查配置 | 仓库根 | 当前仅靠 `hvigorw` 构建与人工审查 | 引入 `code-linter` 配置后把新增告警当门禁 |

## 账怎么记

- **新增**：写码前先入表，注明「为什么是债」与「清账阶段」。
- **清账**：同一提交里删条目 + 在 `docs/CHANGELOG.md` 记一条。
- **收紧**：行数下降时更新数字，不留旧值（旧值会骗人）。

> 判据不是「有没有债」——**债可见且方向向下，比假装没有债更可信。**
