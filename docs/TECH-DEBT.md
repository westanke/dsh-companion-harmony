# 技术债务台账

> 台账不是豁免，**是债务**：每条都注明在哪一阶段清掉。
> **只许收紧**：条目对应的债务消失，同一提交里删掉该条目（自证非空转）。
> **上调必须带理由**：超过行数预算只许带理由在同一提交里上调，且必须在下一阶段拆回。
>
> 制度来源见 `AGENTS.md` §4；本文件为**手工台账**（ArkTS 侧无等价解析器）。
> 它回答的问题是「欠了多少、在往哪个方向走」，不是「谁违规了」。
>
> **2026-10-17 收紧**：行数预算与「台账登记」已由 `test/cases/architecture-guard.test.ts`
> **自动校验** —— 超预算文件的台账行必须**含路径 + 记录行数 ≥ 实际行数**才算登记，
> 否则 `cd test && npm test` 变红（本文件因此**部分进 CI**）。中英资源键与占位符一致性
> 另由 `test/cases/strings-parity.test.ts` 盯住。**所以本文件的表格数字要跟着代码一起更新，
> 留着过期的旧行数会直接让门禁红。**

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

### 2026-10-17 移植批次带来的新超预算文件（**待拆**）

**为什么这一批又冒出来**：`2026-10-15` 的拆分基线是**当时的代码**。此后 Android v2.2.42
的移植批次（第 1 / 2 / 4 批）往**已经接近上限**的两个文件里继续加：`ChatDetail` 多了
滚动冻结、过程组展开、消息级分叉确认、图片查看器、轨迹页覆盖；`SettingsScreen` 多了
外观组（字号缩放）、构建水印行、插件过旧警告横幅。**功能都对，但行数越了线**。

计划拆分（按风险从低到高，逐项单独提交）：

| 文件 | 现测行数 | 计划拆为 | 判据（拆完必须满足） |
|---|---|---|---|
| `ui/SettingsScreen.ets` | 979 | `SettingsScreen.ets` / `SettingsGroups.ets` | 「外观」与「服务端信息」两组各自成 `@Component`，回调以 `(value) => void` 显式传入；设置页对外行为不变 |
| `ui/ChatDetail.ets` | 1352 | `ChatDetail.ets` / `ChatDetailTodo.ets` / `ChatDetailOverlays.ets` | 待办面板、图片查看器、轨迹覆盖层各自成 `@Component`；`bindContentCover` 的 `isShow` 仍只有一个来源（住在 `ChatDetail`） |

> **本次上调理由（2026-10-20，1207 → 1352，+145）**：接入「正文文件链接化」时，
> `ui/ChatDetail.ets` 多出三块**必须住在装配层**的东西 ——
> ① 已知文件清单与投影缓存同步（`knownFilePaths` / `projKnownPaths` + `linkified`），
> ② 链接分流（`openChatLink` / `openSessionFileFromLink` / `linkReasonText`：要读 vm、
> 要开 `sheetOpen`，两样都只有装配层拿得到），③ 大量注释（分流四条分支的判据、
> 「只加载不开面板 = 点了没反应」这条真机结论）。
> 判据函数本身（`ChatLinkTarget` / `PathLinks` / `InlineSegments`）**都不在本文件**，
> 所以这里增的是装配代码而不是逻辑 —— 结构问题与上一条同源，
> **清账方式不变**：仍按上表拆为三个 `@Component`，拆完行数回落到预算内。

> **本次上调理由（2026-10-17）**：`ui/SettingsScreen.ets` 由 967 上调至 979（+12）。
> 原因是修坑 40（`SwitchRow.title` / `description` 漏 `@Prop`）时**只增注释、不改结构** ——
> 这个坑的判据必须写在成员声明处，否则下一个人会把 `@Prop` 当成「多余的装饰」删掉。
> 功能无净增，行的增量全是解释。**清账方式不变**：仍按上表拆为两个 `@Component`，
> 拆完行数回落到预算内，届时删掉本行与上表对应行。

> **必须在能编译的环境里做**：ArkUI 的状态装饰器与 `@Builder` 的 `this` 捕获边界，
> 静态写法对错只有编译器说了算；本轮环境无法编译（见 `docs/STATUS.md` 文末），
> 盲拆分一旦错在 `bindContentCover` / `@Prop` 上，坏掉的是**会话主界面**。
> 所以先记账、不改结构 —— 这正是台账的用途。

## 已清账

**（2026-10-15）** 把上一版在册的 7 个文件**全部拆至 900 行以内**，
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
| DEBT-004 | `@Prop` 审计未逐条上机（**分支内**动态成员） | `ui/ChatDetailPanels.ets` 的 `QuestionCard.answered` / `ApprovalPanel.submitting` / `canWrite`，`ui/MessageParts.ets` 的 `ToolTextBlock.isError`，`ui/PluginsScreen.ets` 的 `PluginRow.busy` | 只在「节点已出现、值又在同一次停留里变化」的时序下才暴露（如审批卡片已弹出、随后 `submitting` 翻转）；坑 40 的全仓审计**已确认键/分支覆盖了绝大多数**，这几处本轮拿不到真机时序证据，不凭「像动态」就改 | 在这几处各造一次真机时序（出现后值变化并 dump 取证）；确认为缺陷则补 `@Prop`，确认键/分支已保证重建则从本表删除 |

## 账怎么记

- **新增**：写码前先入表，注明「为什么是债」与「清账阶段」。
- **清账**：同一提交里删条目 + 在 `docs/CHANGELOG.md` 记一条。
- **收紧**：行数下降时更新数字，不留旧值（旧值会骗人）。

> 判据不是「有没有债」——**债可见且方向向下，比假装没有债更可信。**
