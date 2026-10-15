/**
 * 聊天页的**呈现模型** —— 移植自原工程 `data/ChatPresentation.kt`（825 行）。
 *
 * 这个文件是「服务端事件 → 界面能看到的一行行东西」之间唯一的接缝：
 * 聊天页（`ChatScreen`）不直接读事件，只读这里吐出来的 `ChatDisplayItem[]`。
 *
 * ## 本文件只是索引（barrel）
 *
 * 原来是 1 456 行的一个大文件，按层次拆成了六份，**对外的名字一个没变**：
 *
 * | 文件 | 装什么 |
 * | --- | --- |
 * | `ChatPresentationTypes.ts` | 数据形状与交接标记常量 |
 * | `ChatJson.ts` | 宽松取值（复刻 kotlinx `JsonPrimitive`） |
 * | `ChatEventParsers.ts` | 对外解析入口（`chatDelta` / `displayItemsOf` / …） |
 * | `ChatItemBuilders.ts` | 一条条 `ChatDisplayItem` 怎么拼出来 |
 * | `ChatToolItems.ts` | 工具条目的构造与合并 |
 * | `ChatToolFormat.ts` | 工具信息取值、耗时、动作短语 |
 *
 * 拆分是逐字节搬运，没有任何行为变化；调用方仍然 `import { … } from './ChatPresentation'`。
 * 新文件里内部声明统一带 `export`（跨文件引用必须显式导出），但**下面的转发清单才是公共面** ——
 * 没在清单里的名字不属于对外 API。
 *
 * ## 三条贯穿全模块的取向
 *
 * 1. **只认能读懂的**。`turn/start`、`step/end` 这类协议生命周期事件一律不渲染；
 *    `assistant/message` 里 `tool-call` 块也只认 `tool/call` 事件，不在这里二次解析。
 * 2. **不猜**。参数解析失败就原样给原始文本，工具结果配不上 callId 就整条不显示。
 *    「少一行」永远好过「编一行」。
 * 3. **判据要能分清「空串」与「没有」**。失败行的 `code` 空串是**合法值**
 *    （免费额度限流的 code 就是 `""`），界面要照原样显示那一格，不能当缺失。
 *
 * ## 与安卓版的差异
 *
 * - 资源 id：Kotlin 返回 `@StringRes Int`；ArkTS 取资源只认编译期字面量，所以这里
 *   返回**字符串 key**（`turn_failed_title` / `turn_stopped_title`），由界面按 key
 *   switch 到 `$r` 字面量。与 `ErrorMessages` 的既定口径一致。
 * - `intValue` / `booleanValue` 的取值语义按 kotlinx 的 `intOrNull` /
 *   `toBooleanStrictOrNull` 复刻（见 `ChatJson`），而不是直接用 JS 的宽松转换。
 */

export {
  HANDOFF_ATTACHMENT_PREFIX, ChatItemKind, ChatTurnFailure, ChatAttachment, ToolCallDetail, ChatDisplayItem,
  ChatDelta, LiveChatBlock, LiveChatState, ChatDeliverable,
} from './ChatPresentationTypes';

export {
  chatDelta, chatTurnFailure, displayItemsOf, todoItemsOf, permissionSelectOf, deliverablesOf, handoffPathOf,
} from './ChatEventParsers';

export {
  toolActionsFor, toolDurationMs, formatToolDuration, prettyToolArguments,
} from './ChatToolFormat';

