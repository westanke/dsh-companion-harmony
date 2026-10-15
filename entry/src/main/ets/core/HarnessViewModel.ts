/**
 * 界面主状态机 —— 移植自原工程 `HarnessViewModel.kt`（约 4 000 行，Kotlin）。
 *
 * ## 与安卓版的机制差异（刻意的，逐条都有理由）
 *
 * 1. **无 StateFlow**：`HarnessState` 是一个普通 class，字段默认值与 Kotlin 的 `data class`
 *    逐字对应。`update(fn)` **就地改**共享状态、`revision++`、通知监听者；不重建整份对象。
 *    对外暴露 `state`、`subscribe(listener)`、`revision`。
 * 2. **无协程**：全部改 async/await。Kotlin 的 `viewModelScope.launch { ... }` 对应
 *    「方法返回 Promise」。但有一条**必须保留**：`sendMessage` 要在**调用线程同步**取走并
 *    清空 `pendingAttachments`（防双击），见该方法的注释。
 * 3. **本地文件不做流式读写**：平台层已经把文件读成 `Uint8Array` 再传进来，
 *    Kotlin 的 `InputStream` / `OutputStream` / `readAtMost(limit+1)` 那一层保护改由平台层承担。
 * 4. **定时器注入**：400ms 去抖用 `HarnessDeps.timers`，不引 `setTimeout`。理由见
 *    `scheduleChatRefresh`。
 * 5. **文案走 core 表**：`appString(R.string.xxx)` → `toastText(key, lang, arg)`。
 *    ArkTS 取资源只认编译期字面量，运行期拼 key 行不通（详见 `ErrorMessages.ts` 头注释）。
 * 6. **异常收敛**：安卓那 7 个 `IOException` 分支在这里收敛成「`NetworkException` 一条」。
 *
 * ## 拆分说明：这是一个 8 文件的模块，本文件是**索引 + 末端的空壳类**
 *
 * 拆分前是 3 345 行的一个文件。ArkTS 里跨文件共享私有状态只有"继承"一条路，
 * 而继承只能**单向**，所以拆出来的层必须按依赖关系排成一条链
 * （被所有人依赖的排最前，依赖大家的排最后）：
 *
 * | # | 文件 | 装什么 | 依赖谁 |
 * | --- | --- | --- | --- |
 * | 0 | `HarnessTypes.ts` | 状态与类型（`HarnessState` / `OpenDocument` / …） | — |
 * | 0 | `HarnessHelpers.ts` | 纯函数与 `HarnessDeps` | 类型层 |
 * | 1 | `HarnessViewModelBase.ts` | 字段/构造/订阅/`update`/执行壳（`withClient` 等） | 0 |
 * | 2 | `HarnessViewModelCatalog.ts` | 命令 / 模型 / 供应商 / 插件 | 1 |
 * | 3 | `HarnessViewModelFiles.ts` | 文件浏览与编辑 | 1 |
 * | 4 | `HarnessViewModelSessions.ts` | 会话（含打开会话文件） | 2、3 |
 * | 5 | `HarnessViewModelComposer.ts` | 发送与附件 | 1 |
 * | 6 | `HarnessViewModelConnection.ts` | 连接管理 + 启动恢复 + 事件流 | 2、3、4、5 |
 * | — | `HarnessViewModel.ts`（本文件） | 索引 + `class HarnessViewModel` 空壳 | 6 |
 *
 * **链序是这套拆法的机械后果，不是设计偏好**：例如第 4 层的选会话要调第 2 层的
 * `refreshCommands`、第 3 层的 `loadDirectory`，所以它们只能排在前面。
 * 两处机械改写（不改语义）：类内 `private` → `protected`；方法体里的
 * `const self: HarnessViewModel = this` 改成各自文件的类名。
 *
 * **对外接口一个字没变**：外部仍 `import { HarnessViewModel, HarnessState } from './HarnessViewModel'`。
 * 本文件不 import 任何 `@ohos.*`，可直接在 node 单测里跑。
 */

export {
  MAX_EDIT_BYTES, PREVIEW_CHARS, CONFIG_INVALID, LAST_ENDPOINT, PLUGIN_TOO_OLD, FILE_TOO_LARGE, BINARY_FILE,
  COMMAND_FAILED, OpenDocument, SessionFileOpen, PendingAttachment, ApprovalUiKind, ApprovalUiState, HarnessState,
} from './HarnessTypes';

export {
  COMMAND_NAME, isHostCommandLine, QUESTION_REFRESH_EVENTS, removeQuestion, isToolResultFrame, markSessionStopped,
  SessionFileOutcome, DecodedText, LiveKey, decodeUtf8, concatBytes, childPath, substringBeforeLast,
  substringAfterLast, distinctById,
} from './HarnessHelpers';

// `HarnessDeps` 是 interface（纯类型），必须用 `export type` 再导出 —— 运行期没有这个绑定，
// 用值式 `export {}` 会在 node（tsx/esbuild）下报 "does not provide an export named"。
export type { HarnessDeps } from './HarnessHelpers';

import { HarnessViewModelConnection } from './HarnessViewModelConnection';

/**
 * 对外的唯一入口。**故意是空壳**：实现散在继承链的六层里，好处是每个文件都能单独读；
 * 代价是类名与实现的物理位置分开了 —— 找方法请看文件头的链序表。
 */
export class HarnessViewModel extends HarnessViewModelConnection {
}
