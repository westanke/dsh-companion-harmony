# 技术债务台账

> 台账不是豁免，**是债务**：每条都注明在哪一阶段清掉。
> **只许收紧**：条目对应的债务消失，同一提交里删掉该条目（自证非空转）。
> **上调必须带理由**：超过行数预算只许带理由在同一提交里上调，且必须在下一阶段拆回。
>
> 制度来源见 `AGENTS.md` §4；本文件为**手工台账，暂不进 CI**（ArkTS 侧无等价解析器）。
> 它回答的问题是「欠了多少、在往哪个方向走」，不是「谁违规了」。

## 行数预算

**当前预算：900 行/文件。** 基线测量日：**2026-10-15**（源文件，测试不计）。

> 预算先由 800 上调至 1 000，理由：ArkTS 单文件承载能力高于 Kotlin——
> 泛型与接口表达能力更弱，同样逻辑需要更多样板（`@Observed` / `@Prop` 声明、
> `interface` 显式展开、规避继承覆盖歧义而采用的扁平判别式写法），
> 按 Kotlin 的 800 行卡会把正常的模块判成债。
> 本轮用户要求「按 **900 行左右** 拆分」，遂**收紧至 900**。上调阶段在册的
> `ui/GenUiCard.ets`(897)、`ui/ModelsScreen.ets`(865)、`core/DshClient.ts`(854)
> 仍在 900 以内，继续留在 `DEBT-003` 跟踪。

## 在册文件

**空。** 本轮（2026-10-15）把上一版在册的 7 个文件**全部拆至 900 行以内**，
对外接口与行为不变（`BUILD SUCCESSFUL` + `531 用例全绿`，**用例数未降**）。
清账记录如下（「拆后最大」= 该组拆分产物的最大行数）：

| 原文件 | 原行数 | 拆为 | 拆后最大 | 判据 |
|---|---|---|---|---|
| `core/HarnessViewModel.ts` | 3 345 | `HarnessTypes` / `HarnessHelpers` / `ViewModelBase` / `Catalog` / `Files` / `Sessions` / `Composer` / `Connection` / barrel 空壳 | 779（`Connection`） | `harnessVm()` / `harnessState()` 不变 |
| `ui/ChatDetail.ets` | 1 939 | `ChatDetail.ets`（装配层）/ `ChatHeader.ets` / `ChatComposer.ets` / `ChatDetailPanels.ets` | 763（`ChatDetail`） | 头部 / 输入区 / 三面板各自成文件 |
| `core/Models.ts` | 1 542 | `Models.ts`(barrel) / `ModelsWire` / `ModelsFiles` / `ModelsChat` / `ModelsConfig` / `ModelsEvents` | 524（`ModelsConfig`） | 对外导出名不变 |
| `core/ChatPresentation.ts` | 1 456 | `ChatPresentation.ts`(barrel) / `ChatPresentationTypes` / `ChatJson` / `ChatEventParsers` / `ChatItemBuilders` / `ChatToolItems` / `ChatToolFormat` | 342 | 对外导出名不变 |
| `ui/FilesScreen.ets` | 1 440 | `FilesScreen.ets` / `FilesLayout.ts` / `FileBrowser.ets` / `EditorPane.ets` | 511（`FileBrowser`） | 目录浏览 / 行号编辑器 / 预览各自成文件 |
| `ui/ChatScreen.ets` | 1 125 | `ChatScreen.ets` / `SessionRow.ets` / `SessionSheets.ets` | 657（`SessionSheets`） | 列表 / 会话行 / 新建与工作区面板各自成文件 |
| `ui/ChatMessage.ets` | 1 099 | `ChatMessage.ets` / `MarkdownView.ets` / `MessageParts.ets` | 491（`MessageParts`） | Markdown 与消息零件各自成文件 |

**为什么 `HarnessViewModel` 拆成「继承链」而不是「组合」**：ArkTS 里跨文件共享**私有状态**
只有「继承」一条路，且继承是单向的；同时 `export { X } from './Y'` 转发导出可让 barrel 保住
对外接口。抽象基类的构造末尾改用一个可覆盖钩子 `startRestore()`，打断「最底层反向依赖最后
一层」造成的成环（详见 `HarnessViewModel.ts` barrel 里的依赖表注释、`docs/CHANGELOG.md`）。

> 清账不等于功能对等审查：本轮只做了**结构**拆分（文件），**没有**做 `ConnectionViewModel` /
> `ChatViewModel` / `FilesViewModel` / `PluginsViewModel` 的**对象**切分。`core/HarnessViewModel` 的
> 继承链仍是一个大对象，只是分散到 9 个文件里 —— 这一点在 `docs/ROADMAP.md` 1.1.0 段已注明。

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
