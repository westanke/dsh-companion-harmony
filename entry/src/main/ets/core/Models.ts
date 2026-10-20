/**
 * 服务端线上模型（wire models）—— 移植自原工程 `data/Models.kt`（544 行）。
 *
 * **本文件只是索引（barrel）**：类按领域拆到下面几个文件里，这里按原样把名字再导出一次，
 * 所以外部 `import { ChatSession } from './Models'` 这类写法**一行都不用改**。
 *
 * | 文件 | 装什么 |
 * | --- | --- |
 * | `ModelsWire.ts` | 请求体拼装（`WireBuilder`）、健康检查 / 根 / 设备 / 配对、旧版单连接存储、API 异常 |
 * | `ModelsFiles.ts` | 文件与目录（`FileEntry` / `DirectoryPage` / `ResolvedPath` / `TrashEntry` / `FileContent`） |
 * | `ModelsChat.ts` | 会话、审批、问答、命令、待办、权限选择 |
 * | `ModelsConfig.ts` | 模型选择、供应商设置、插件清单 |
 * | `ModelsEvents.ts` | 消息内容（`PromptContentPart`）、附件、会话事件与历史、工作区事件 |
 *
 * 三条贯穿全模块的规矩，全部来自上游踩过的坑，改动前请先读：
 *
 * 1. **字段一律给默认值**。原工程用的是严格解码器（`ignoreUnknownKeys` 只放过多余的键，
 *    缺键照样抛异常），历史上因为 `AgentPreset.trust` 缺键、`PluginInventory.profile`
 *    显式 null、`ResolvedPath` 增删字段，三次把整页数据打挂。ArkTS 这边没有严格解码器，
 *    但我们仍按同样策略实现：**缺键 / 显式 null / 类型不符 → 一律退化为默认值，绝不抛异常**
 *    （全靠 `JsonAccess`）。
 *
 * 2. **编码请求体时 null 一律省略**。对齐 kotlinx 的 `Json { ignoreUnknownKeys = true }`
 *    默认语义（`encodeDefaults = false`）：声明为 `= null` 的字段没设值时不写该键。
 *    唯一被上游专门点名的是 `QuestionAnswer.custom`——默认 `""` 时**干脆不出现 `custom` 键**，
 *    而不是发 `"custom": null` 让服务端去猜。
 *
 * 3. **判别联合（PromptPart）用 type 判别器**。内核的 `PromptContentPart` 是 union，
 *    多一个字段就可能让服务端解析失败，所以按 type 分派后**只写该形态的字段**。
 */

export {
  type JsonMapArray,
  HealthView,
  RootView,
  DeviceView,
  PairingResult,
  StoredConnection,
  DshApiException,
} from './ModelsWire';

export {
  FileEntry,
  DirectoryPage,
  ResolvedPath,
  TrashEntry,
  FileContent,
} from './ModelsFiles';

export {
  ChatSession,
  CreatedSession,
  RenamedSession,
  ChatWorkspace,
  AgentPreset,
  PendingApproval,
  APPROVAL_OUTCOME_ALLOWED_ONCE,
  APPROVAL_OUTCOME_REJECTED,
  QUESTION_STATE_CONTINUED,
  QuestionOption,
  ChatQuestion,
  PendingQuestionSet,
  QuestionAnswer,
  QuestionAnswerRequest,
  CommandInput,
  CommandDescriptor,
  CommandResult,
  CommandExecution,
  TodoItem,
  TodoItemList,
} from './ModelsChat';

export {
  PermissionOption,
  PermissionSelect,
  PermissionCatalog,
  ModelSelection,
  ModelReasoningEffort,
  ModelReasoning,
  ModelView,
  ModelProviderGroup,
  ModelFailure,
  SessionModels,
  ProviderModel,
  ProviderConfig,
  CredentialState,
  ProviderView,
  CustomProviderCapability,
  ProviderSettings,
  ProviderPatch,
  CustomProviderCreate,
  PluginEntry,
  PluginToggleResult,
  PluginToggleRequest,
  PluginInventory,
} from './ModelsConfig';

export {
  PromptPart,
  type PromptContentPart,
  UploadedAttachment,
  SessionEvent,
  HistoryEntry,
  ChatHistory,
  WorkspaceEvent,
  eventDataString,
  eventDataInt,
} from './ModelsEvents';
