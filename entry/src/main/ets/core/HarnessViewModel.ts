/**
 * 界面主状态机 —— 移植自原工程 `app/src/main/java/io/github/hakunm/deepseekharness/HarnessViewModel.kt`。
 *
 * ## 与安卓版的机制差异（刻意的，逐条都有理由）
 *
 * 1. **无 StateFlow**：`HarnessState` 是一个普通 class，字段默认值与 Kotlin 的 `data class`
 *    逐字对应。`update(fn)` **就地改**共享状态、`revision++`、通知监听者；不重建整份对象。
 *    对外暴露 `state`、`subscribe(listener)`、`revision`。
 *
 * 2. **无协程**：全部改 async/await。Kotlin 的 `viewModelScope.launch { ... }` 对应
 *    「方法返回 Promise」。但有一条**必须保留**：`sendMessage` 要在**调用线程同步**取走并
 *    清空 `pendingAttachments`（防双击），见该方法的注释。
 *
 * 3. **本地文件不做流式读写**：平台层已经把文件读成 `Uint8Array` 再传进来
 *    （`attachImage(name, mediaType, bytes)` / `attachFile(name, bytes)` / `upload(name, bytes)` /
 *    `replaceSelected(bytes)`），Kotlin 的 `InputStream` / `OutputStream` /
 *    `ChatContentParts.readAtMost(limit+1)` 那一层保护改由平台层承担，本文件只按
 *    `bytes.length` 与 `MAX_IMAGE_BYTES` / `MAX_FILE_BYTES` 比一比。
 *
 * 4. **定时器注入**：400ms 去抖用 `HarnessDeps.timers`，不引 `setTimeout`。理由见
 *    `scheduleChatRefresh`。
 *
 * 5. **文案走 core 表**：`appString(R.string.xxx)` → `toastText(key, lang, arg)`。
 *    ArkTS 取资源只认编译期字面量，运行期拼 key 行不通（详见 `ErrorMessages.ts` 头注释）。
 *
 * 6. **异常收敛**：安卓那 7 个 `IOException` 分支在这里收敛成「`NetworkException`
 *    一条」—— 平台层已经把错误码翻译成 `NetworkFailureKind` 再抛，core 不必认识
 *    `SocketTimeoutException` 这些平台类（**有意简化**）。`DshConnectionException`
 *    与 `DshApiException` 仍各走各的本地化。
 *
 * 本文件不 import 任何 `@ohos.*`，可直接在 node 单测里跑。
 */

import {
  AgentPreset,
  ChatHistory,
  ChatSession,
  ChatWorkspace,
  CommandDescriptor,
  CommandExecution,
  CreatedSession,
  CustomProviderCreate,
  DeviceView,
  DirectoryPage,
  DshApiException,
  FileContent,
  FileEntry,
  HistoryEntry,
  ModelSelection,
  PairingResult,
  PendingApproval,
  PendingQuestionSet,
  PluginInventory,
  PromptPart,
  ProviderModel,
  ProviderPatch,
  ProviderSettings,
  QuestionAnswer,
  ResolvedPath,
  RootView,
  SessionModels,
  TrashEntry,
  UploadedAttachment,
  WorkspaceEvent,
  eventDataInt,
  eventDataString,
} from './Models';
import { DshClient, TimerBridge } from './DshClient';
import {
  ActiveConnection,
  ConnectionCoordinator,
  DshClientFactory,
  DshConnectionException,
} from './ConnectionCoordinator';
import {
  Credential,
  CredentialKind,
  Endpoint,
  EndpointProbe,
  Host,
} from './ConnectionModels';
import { HostStore, KeyValueStore, SecretBox } from './HostStore';
import { LegacyConnectionMigration } from './ConnectionStorage';
import { ConnectionShare, SharePayload } from './ConnectionShare';
import { AppPreferences } from './AppPreferences';
import { normalizeEndpoint, stripApiSuffix } from './EndpointUrl';
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  formatBytes,
  imagePart,
} from './ChatContentParts';
import {
  ChatDelta,
  ChatTurnFailure,
  LiveChatState,
  chatDelta,
  chatTurnFailure,
  handoffPathOf,
} from './ChatPresentation';
import {
  PreviewKind,
  binaryPreviewByteLimit,
  previewKind,
  previewKindOf,
} from './PreviewKind';
import { UTF8_BOM, utf8DecodeStrict, utf8Encode } from './Codec';
import {
  isBlank,
  isKotlinWhitespace,
  isNotBlank,
  trimChar,
  trimEndText,
  trimText,
} from './TextPredicates';
import {
  NetworkException,
  allEndpointsUnreachableText,
  localizedErrorText,
  networkErrorText,
  toastText,
} from './ErrorMessages';
import { SEND_MODE_QUEUE } from './ComposerSendPolicy';
import { JsonAccess } from './JsonAccess';

/** 文本编辑的内存闸：与 Kotlin `MAX_EDIT_BYTES` 一致（2 MiB）。 */
const MAX_EDIT_BYTES: number = 2 * 1024 * 1024;
/** 面板只读预览的字符上限（整个文件仍按 2 MiB 上限读进 document 供编辑器用）。 */
const PREVIEW_CHARS: number = 20000;

/**
 * 界面兜底码（对应原工程 `UiCodes`）。
 *
 * 这些不是服务端错误码，而是界面**写死**的少数几种「本地原因」：配置文本解不开、
 * 这是最后一个地址、端点不存在（插件旧）、文件过大、是二进制、命令执行失败。
 * 界面渲染时按码取本地文案，绝不把这些字符串直接显示给用户。
 */
export const CONFIG_INVALID: string = 'CONFIG_INVALID';
export const LAST_ENDPOINT: string = 'LAST_ENDPOINT';
export const PLUGIN_TOO_OLD: string = 'PLUGIN_TOO_OLD';
export const FILE_TOO_LARGE: string = 'FILE_TOO_LARGE';
export const BINARY_FILE: string = 'BINARY_FILE';
export const COMMAND_FAILED: string = 'COMMAND_FAILED';

// ---------------------------------------------------------------------------
// 纯数据类（对应 Kotlin 的 data class / sealed interface）
// ---------------------------------------------------------------------------

/** 「文件」页正在编辑的那一份文档。 */
export class OpenDocument {
  entry: FileEntry;
  text: string | null;
  etag: string;
  hasBom: boolean;
  lineEnding: string;
  contentType: string | null;
  /**
   * 原始字节，**只有图片 / PDF 这类要交给解码器的东西才留**。
   *
   * 文本预览走 `text`（已解成 String），再留一份字节纯属浪费；而图片 / PDF 没法从
   * String 还原，必须留原字节 —— 这是它们与文本预览最本质的区别。
   */
  bytes: Uint8Array | null;
  /**
   * 预览是被**主动跳过**的（文件超过该类文件的上限），而不是「还没加载」。
   *
   * 两者在界面上完全不同：前者要给「文件过大 + 下载」的出路，后者只是还没读。
   */
  skippedForSize: boolean;

  constructor(entry: FileEntry, text: string | null = null, etag: string = '', hasBom: boolean = false,
              lineEnding: string = '\n', contentType: string | null = null,
              bytes: Uint8Array | null = null, skippedForSize: boolean = false) {
    this.entry = entry;
    this.text = text;
    this.etag = etag;
    this.hasBom = hasBom;
    this.lineEnding = lineEnding;
    this.contentType = contentType;
    this.bytes = bytes;
    this.skippedForSize = skippedForSize;
  }

  /** 只改正文的副本（对应 Kotlin `document.copy(text = text)`）。 */
  withText(text: string): OpenDocument {
    return new OpenDocument(this.entry, text, this.etag, this.hasBom, this.lineEnding,
      this.contentType, this.bytes, this.skippedForSize);
  }

  /** 只改 etag 的副本（对应 Kotlin `document.copy(etag = etag)`）。 */
  withEtag(etag: string): OpenDocument {
    return new OpenDocument(this.entry, this.text, etag, this.hasBom, this.lineEnding,
      this.contentType, this.bytes, this.skippedForSize);
  }
}

/**
 * 「本会话的文件」面板里正在查看的那一条。
 *
 * 故意不复用全局 `error` 通道：路径不在授权根内是**正常结果**（agent 提到的文件未必
 * 授权给这台手机），用户需要的是面板里一句解释，而不是一次全局错误提示。
 */
export class SessionFileOpen {
  /** 发起这次打开操作的会话 id。切到别的会话后，这个结果就不该再显示。 */
  sessionId: string;
  /** 会话里原样的绝对路径（请求的目标）。 */
  requestedPath: string;
  loading: boolean;
  resolved: ResolvedPath | null;
  preview: string | null;
  /** 图片 / PDF 的原始字节；文本预览不用这个字段。 */
  bytes: Uint8Array | null;
  truncated: boolean;
  tooLarge: boolean;
  /** 服务端说不属于任何授权根（或不是普通文件）。 */
  outsideRoots: boolean;
  /** 其他失败原因，已是可直接展示的文本。 */
  failure: string | null;

  constructor(sessionId: string, requestedPath: string, loading: boolean = true,
              resolved: ResolvedPath | null = null, preview: string | null = null,
              bytes: Uint8Array | null = null, truncated: boolean = false, tooLarge: boolean = false,
              outsideRoots: boolean = false, failure: string | null = null) {
    this.sessionId = sessionId;
    this.requestedPath = requestedPath;
    this.loading = loading;
    this.resolved = resolved;
    this.preview = preview;
    this.bytes = bytes;
    this.truncated = truncated;
    this.tooLarge = tooLarge;
    this.outsideRoots = outsideRoots;
    this.failure = failure;
  }
}

/**
 * 一条已经准备好、等着随消息一起发出去的附件。
 *
 * 图片在 `part` 里已经内联好了 base64（`imageBytes` 只是留一份原图给界面画缩略图，
 * 不会重复编码）；文件在 `part` 里是上传换来的 `receiptId`。
 *
 * `id` 与 `part` 分开：同一个文件可以被选两次，而去重、删除都必须按「这一条」来认，
 * 不能按内容认。
 */
export class PendingAttachment {
  id: string;
  part: PromptPart;
  name: string;
  sizeBytes: number;
  /** 仅图片：原图字节，供缩略图使用。 */
  imageBytes: Uint8Array | null;

  constructor(id: string, part: PromptPart, name: string, sizeBytes: number = 0,
              imageBytes: Uint8Array | null = null) {
    this.id = id;
    this.part = part;
    this.name = name;
    this.sizeBytes = sizeBytes;
    this.imageBytes = imageBytes;
  }
}

/** 审批面板的四态（对应 Kotlin sealed interface `ApprovalUiState`）。 */
export enum ApprovalUiKind {
  NONE = 'none',
  LOADING = 'loading',
  PENDING = 'pending',
  DECIDING = 'deciding',
}

export class ApprovalUiState {
  readonly kind: ApprovalUiKind;
  readonly items: PendingApproval[];
  readonly item: PendingApproval | null;

  constructor(kind: ApprovalUiKind, items: PendingApproval[] = [], item: PendingApproval | null = null) {
    this.kind = kind;
    this.items = items;
    this.item = item;
  }

  static none(): ApprovalUiState {
    return new ApprovalUiState(ApprovalUiKind.NONE);
  }

  static loading(): ApprovalUiState {
    return new ApprovalUiState(ApprovalUiKind.LOADING);
  }

  static pending(items: PendingApproval[]): ApprovalUiState {
    return new ApprovalUiState(ApprovalUiKind.PENDING, items, null);
  }

  static deciding(item: PendingApproval, items: PendingApproval[]): ApprovalUiState {
    return new ApprovalUiState(ApprovalUiKind.DECIDING, items, item);
  }
}

/**
 * 界面共享状态。字段与默认值**逐字对应** Kotlin 的 `data class HarnessState`。
 *
 * 这是普通 class（不是 immutable）：`HarnessViewModel.update(fn)` 就地改它。
 */
export class HarnessState {
  restoring: boolean = true;
  busy: boolean = false;
  endpointDraft: string = 'http://192.168.1.20:3090';
  healthOk: boolean = false;
  connected: boolean = false;
  endpoint: string = '';
  // ——— 多主机 / 多地址连接层 ———
  /** 已保存的全部电脑。 */
  hosts: Host[] = [];
  /** 当前连上的电脑 id。 */
  activeHostId: string | null = null;
  /** 当前实际使用的地址 id（多地址里的胜出者）。 */
  activeEndpointId: string | null = null;
  /** 最近一次探活的逐地址结果，用于诊断面板。 */
  endpointProbes: EndpointProbe[] = [];
  /** 正在并发探活/建连。 */
  connecting: boolean = false;
  /** 界面上被选中查看/编辑的电脑（不一定是当前连上的那台）。 */
  selectedHostId: string | null = null;
  device: DeviceView | null = null;
  roots: RootView[] = [];
  sessions: ChatSession[] = [];
  chatWorkspaces: ChatWorkspace[] = [];
  agentPresets: AgentPreset[] = [];
  workspacePickerRootId: string | null = null;
  workspacePickerPath: string = '';
  workspacePickerDirectory: DirectoryPage | null = null;
  sessionModels: SessionModels | null = null;
  commands: CommandDescriptor[] = [];
  providerSettings: ProviderSettings | null = null;
  /** 插件清单；null 表示尚未读取（未连接、无 settings.read 权限或读取失败）。 */
  pluginInventory: PluginInventory | null = null;
  discoveredModels: ProviderModel[] = [];
  selectedSessionId: string | null = null;
  history: ChatHistory | null = null;
  liveChat: LiveChatState | null = null;
  approvalState: ApprovalUiState = ApprovalUiState.none();
  /**
   * 当前会话待回答的问题（只留 state === continued 的那些）。
   *
   * 与 `approvalState` **分开**存：审批是内核阻塞着等决定、必须占用输入区；
   * 问题是 Agent 已经继续跑了、答复属于补交，不能顶掉输入框。
   */
  questions: PendingQuestionSet[] = [];
  /** 正在提交答案的那一组（null = 空闲）。既驱动 loading，也是防重复提交的闸。 */
  answeringCallId: string | null = null;
  /** 已经提交成功的 callId：卡片转「已回答」态，不再显示可操作控件。 */
  answeredCallIds: Set<string> = new Set<string>();
  eventsConnected: boolean = false;
  selectedRootId: string | null = null;
  currentPath: string = '';
  directory: DirectoryPage | null = null;
  /** 当前会话工作目录（cwd）下的条目，供输入框 `@` 补全用；null 表示还没加载。 */
  mentionEntries: FileEntry[] | null = null;
  /** `@` 补全这次**尝试过但没拿到**（网络失败、会话没有可用工作目录…）。 */
  mentionFailed: boolean = false;
  /** 输入框上方是否开着补全面板（`@` 文件补全，或 `/` 命令补全）。 */
  composerOverlay: boolean = false;
  document: OpenDocument | null = null;
  /** 会话文件面板正在查看的那一条（null 表示面板显示路径列表）。 */
  sessionFileOpen: SessionFileOpen | null = null;
  trash: TrashEntry[] = [];
  /**
   * 智能体正在运行时，Enter 与主发送按钮的默认行为。
   *
   * 与 `busy` 的区别很重要：`busy` 是「有任何操作在跑」（连刷新都算），
   * 而这里关心的是「这个会话的 agent 是否在运行」—— 只有后者才谈得上排队与插话。
   */
  busySendMode: string = SEND_MODE_QUEUE;
  /** dsh-ui 诊断行开关，默认关。 */
  genUiDebug: boolean = false;
  /** 会话详情页走 WebView 版还是原生。 */
  useWebChat: boolean = false;
  /** 是否显示上下文注入块。 */
  showContext: boolean = false;
  /**
   * 发送中的输入框原文；发送成功后清空，失败时保留以便还回输入框。
   *
   * 为什么需要它：输入框是本地 UI 状态，发请求在异步里，两者对不上时
   * 「用户刚打的字」就凭空消失了 —— 而用户没有任何办法找回。
   */
  pendingText: string = '';
  /** 已取回的会话图片附件字节，键是 `attachmentId`。 */
  attachmentImages: Map<string, Uint8Array> = new Map<string, Uint8Array>();
  /** 取图失败的 id，值是**人类可读的原因**而不是裸 id。 */
  attachmentFailures: Map<string, string> = new Map<string, string>();
  /**
   * 待发附件条。发送时与文本一起组装成 content 数组，发送成功（或用户在输入区点删除）
   * 之后才消失。
   */
  pendingAttachments: PendingAttachment[] = [];
  /** 有文件正在上传换 `receiptId`。只用来显示进度，不用来禁用发送键。 */
  attachmentUploading: boolean = false;
  error: string | null = null;

  /** 把另一份状态的全部字段盖到自己身上（对应 Kotlin 的整份重建 / `copy`）。 */
  copyFrom(other: HarnessState): void {
    this.restoring = other.restoring;
    this.busy = other.busy;
    this.endpointDraft = other.endpointDraft;
    this.healthOk = other.healthOk;
    this.connected = other.connected;
    this.endpoint = other.endpoint;
    this.hosts = other.hosts;
    this.activeHostId = other.activeHostId;
    this.activeEndpointId = other.activeEndpointId;
    this.endpointProbes = other.endpointProbes;
    this.connecting = other.connecting;
    this.selectedHostId = other.selectedHostId;
    this.device = other.device;
    this.roots = other.roots;
    this.sessions = other.sessions;
    this.chatWorkspaces = other.chatWorkspaces;
    this.agentPresets = other.agentPresets;
    this.workspacePickerRootId = other.workspacePickerRootId;
    this.workspacePickerPath = other.workspacePickerPath;
    this.workspacePickerDirectory = other.workspacePickerDirectory;
    this.sessionModels = other.sessionModels;
    this.commands = other.commands;
    this.providerSettings = other.providerSettings;
    this.pluginInventory = other.pluginInventory;
    this.discoveredModels = other.discoveredModels;
    this.selectedSessionId = other.selectedSessionId;
    this.history = other.history;
    this.liveChat = other.liveChat;
    this.approvalState = other.approvalState;
    this.questions = other.questions;
    this.answeringCallId = other.answeringCallId;
    this.answeredCallIds = other.answeredCallIds;
    this.eventsConnected = other.eventsConnected;
    this.selectedRootId = other.selectedRootId;
    this.currentPath = other.currentPath;
    this.directory = other.directory;
    this.mentionEntries = other.mentionEntries;
    this.mentionFailed = other.mentionFailed;
    this.composerOverlay = other.composerOverlay;
    this.document = other.document;
    this.sessionFileOpen = other.sessionFileOpen;
    this.trash = other.trash;
    this.busySendMode = other.busySendMode;
    this.genUiDebug = other.genUiDebug;
    this.useWebChat = other.useWebChat;
    this.showContext = other.showContext;
    this.pendingText = other.pendingText;
    this.attachmentImages = other.attachmentImages;
    this.attachmentFailures = other.attachmentFailures;
    this.pendingAttachments = other.pendingAttachments;
    this.attachmentUploading = other.attachmentUploading;
    this.error = other.error;
  }
}

// ---------------------------------------------------------------------------
// 顶层纯函数（可在 JVM / node 单测里直接调用）
// ---------------------------------------------------------------------------

/**
 * 宿主命令名：与插件 `chat-adapter.ts` 的判定正则逐字对应。
 *
 * 小写字母开头，其余只允许小写字母、数字、下划线、连字符。**两侧必须一致** ——
 * 放宽会让客户端认为是命令而服务端说 `COMMAND_NOT_FOUND`，收紧则命令永远发不出去。
 *
 * 与 Kotlin `Regex("[a-z][a-z0-9_-]*")` 的一处**必要差异**：那边配的是 `matchEntire`，
 * 即隐式整串匹配；JS 这边没有 `matchEntire`，所以导出时必须自己带上 `^...$` 锚点，
 * 否则调用方写 `COMMAND_NAME.test(name)` 会退化成「子串匹配」——`"Compact"` 与 `"1bad"`
 * 都会被判成真（它们各自含一个合法子串）。锚点是忠实还原，不是收紧。
 */
export const COMMAND_NAME: RegExp = new RegExp('^[a-z][a-z0-9_-]*$');

/**
 * 这一行是不是**宿主命令**（`/compact`、`/clear` 那种），而不是技能名。
 *
 * ## 为什么必须判别，不能只看 `/` 开头
 *
 * 官方把两样东西都做成斜杠开头：宿主命令，与用户技能。分流规则由**客户端**做，
 * 即**命令优先**；不是命令的 `/name` 应当**原样当普通消息发给模型**。
 *
 * 我们此前只要输入以 `/` 开头就整条送去 executeCommand，于是**技能一个都调不动**：
 * 技能名不在宿主命令表里 → `COMMAND_NOT_FOUND`，消息压根到不了模型。
 *
 * ## 匹配规则照抄服务端，不自创
 *
 * 命令名只允许小写字母开头、其余小写字母/数字/下划线/连字符，**精确匹配**，
 * 后面可跟空白与参数。刻意**不**做大小写不敏感：官方与插件都是精确匹配，
 * 避免 `/Compact` 在我们这儿被当成命令、到服务端却被拒。
 */
export function isHostCommandLine(line: string, commands: CommandDescriptor[]): boolean {
  // 命令名后面可以带参数（`/compact 3`），所以只取第一段去比对 ——
  // 与服务端前瞻是同一件事。
  let head: string = '';
  for (let i = 0; i < line.length; i++) {
    if (isKotlinWhitespace(line.charAt(i))) {
      break;
    }
    head = head + line.charAt(i);
  }
  if (!head.startsWith('/')) {
    return false;
  }
  const name: string = head.substring(1);
  if (!COMMAND_NAME.test(name)) {
    return false;
  }
  for (let i = 0; i < commands.length; i++) {
    if (commands[i].name === name) {
      return true;
    }
  }
  return false;
}

/**
 * 「待答问题可能变了」的事件类型（用法见 `HarnessViewModel` 的 connectEvents）。
 *
 * 刻意**不含** chat.message.delta：那是 token 级的流式增量，跟着它刷新就等于在轮询。
 * 这里列的都是每轮 / 每条消息一次的结构性事件 —— 少而准。
 */
export const QUESTION_REFRESH_EVENTS: Set<string> = new Set<string>([
  'chat.message.committed',
  'chat.turn.start',
  'chat.turn.end',
  'chat.session.status',
  'chat.approval.requested',
  'chat.approval.resolved',
]);

/**
 * 从待答列表里摘掉一题。
 *
 * 用在插件那两帧上：`chat.userQuestions/answered` 与 `chat.userQuestions/dismissed`。
 * 两者都是「这道题已经不用答了」的**确定性事实**，所以就地摘掉 —— 而不是等下一次
 * `GET /questions` 回来，那只会让卡片多挂一个往返。
 *
 * 纯函数，便于单测：不改入参、callId 对不上时原样返回。
 */
export function removeQuestion(questions: PendingQuestionSet[], callId: string): PendingQuestionSet[] {
  let hit: boolean = false;
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].callId === callId) {
      hit = true;
      break;
    }
  }
  if (!hit) {
    return questions;
  }
  const out: PendingQuestionSet[] = [];
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].callId !== callId) {
      out.push(questions[i]);
    }
  }
  return out;
}

/**
 * 这一帧是不是 `tool/result`（插件降级成 `chat.session.event` 的那种）。
 *
 * 插件把**所有**非特殊会话事件统一降级成 `chat.session.event`，内容被丢掉，只留
 * `{sessionId, eventType, seq}`。一轮里这类帧非常多（每个工具调用好几帧），若「来一帧
 * 拉一次」，等于自己造了个轮询。而提问超时的判定完全落在内核那条 tool/result 上，
 * 所以**这一帧到达，就是该重新拉取的确切信号** —— 不是启发式，是时序上的事实。
 */
export function isToolResultFrame(eventType: string | null, eventData: Object | null): boolean {
  if (eventType !== 'chat.session.event') {
    return false;
  }
  const map = JsonAccess.asMap(eventData);
  if (map === null) {
    return false;
  }
  const value: Object | null = JsonAccess.raw(map, 'eventType');
  let text: string;
  if (typeof value === 'string') {
    text = value as string;
  } else if (typeof value === 'number') {
    text = `${value as number}`;
  } else if (typeof value === 'boolean') {
    text = (value as boolean) ? 'true' : 'false';
  } else {
    return false;
  }
  // 对应 Kotlin `it.toString().trim('"')`：字符串原样、数字/布尔转文本。
  return trimChar(text, '"') === 'tool/result';
}

/**
 * 收到终局失败帧后，把那个会话在本地立刻标成「不在运行」。
 *
 * 为什么不能等下一次 `GET /sessions`：服务端把会话标成 not-running 与这帧到达之间有
 * 几百毫秒，而这段时间里「停止」按钮还是亮的、输入框占位符还写着「运行中…」——
 * 用户看着就以为还在跑，于是继续傻等。本地先置位，等权威数据回来再用它盖一次。
 *
 * 纯函数，便于单测：不改入参；sessionId 对不上时原样返回。
 */
export function markSessionStopped(sessions: ChatSession[], sessionId: string): ChatSession[] {
  let hit: boolean = false;
  for (let i = 0; i < sessions.length; i++) {
    if (sessions[i].id === sessionId && sessions[i].running) {
      hit = true;
      break;
    }
  }
  if (!hit) {
    return sessions;
  }
  const out: ChatSession[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const s: ChatSession = sessions[i];
    out.push(s.id === sessionId ? s.withRunning(false) : s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 模块内部小工具
// ---------------------------------------------------------------------------

/** `[loadSessionFile]` 的产物：面板要展示的结果 +「文件」页要跟着切换的状态。 */
class SessionFileOutcome {
  open: SessionFileOpen;
  rootId: string | null;
  currentPath: string | null;
  document: OpenDocument | null;

  constructor(open: SessionFileOpen, rootId: string | null = null, currentPath: string | null = null,
              document: OpenDocument | null = null) {
    this.open = open;
    this.rootId = rootId;
    this.currentPath = currentPath;
    this.document = document;
  }
}

/** UTF-8 解码结果。 */
class DecodedText {
  text: string;
  hasBom: boolean;
  lineEnding: string;

  constructor(text: string, hasBom: boolean, lineEnding: string) {
    this.text = text;
    this.hasBom = hasBom;
    this.lineEnding = lineEnding;
  }
}

/** 流式 finalize 的目标（哪一个 turn+step 的实时块该在历史到位后清掉）。 */
class LiveKey {
  sessionId: string;
  turn: number;
  step: number;

  constructor(sessionId: string, turn: number, step: number) {
    this.sessionId = sessionId;
    this.turn = turn;
    this.step = step;
  }
}

/**
 * 按严格 UTF-8 解码：非法字节、含 `\u0000` 的二进制一律判为「不是文本」。
 *
 * 与 Kotlin `decodeUtf8` 同口径：先剥 BOM，再严格解码，再按出现顺序判行尾。
 */
function decodeUtf8(bytes: Uint8Array): DecodedText | null {
  const hasBom: boolean = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  const content: Uint8Array = hasBom ? bytes.subarray(3) : bytes;
  const text: string | null = utf8DecodeStrict(content);
  if (text === null) {
    return null;
  }
  if (text.indexOf('\u0000') >= 0) {
    return null;
  }
  let lineEnding: string = '\n';
  if (text.indexOf('\r\n') >= 0) {
    lineEnding = '\r\n';
  } else if (text.indexOf('\r') >= 0) {
    lineEnding = '\r';
  }
  return new DecodedText(text, hasBom, lineEnding);
}

/** 拼接两个字节串（BOM + 正文）。 */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out: Uint8Array = new Uint8Array(a.length + b.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i];
  }
  for (let i = 0; i < b.length; i++) {
    out[a.length + i] = b[i];
  }
  return out;
}

/** 子路径：父路径为空时只留名字（两侧多余的 `/` 收干净）。 */
function childPath(parent: string, name: string): string {
  return isBlank(parent) ? trimChar(name, '/') : `${parent}/${trimChar(name, '/')}`;
}

/** `substringBeforeLast('/', "")` 的行为（缺分隔符时返回空串）。 */
function substringBeforeLast(value: string, sep: string): string {
  const at: number = value.lastIndexOf(sep);
  return at < 0 ? '' : value.substring(0, at);
}

/** `substringAfterLast('/', "")` 的行为（缺分隔符时返回空串）。 */
function substringAfterLast(value: string, sep: string): string {
  const at: number = value.lastIndexOf(sep);
  return at < 0 ? '' : value.substring(at + sep.length);
}

/** 按 id 去重（保留先出现的那条），对应 Kotlin `distinctBy { it.id }`。 */
function distinctById(attachments: PendingAttachment[]): PendingAttachment[] {
  const out: PendingAttachment[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const a: PendingAttachment = attachments[i];
    let dup: boolean = false;
    for (let k = 0; k < out.length; k++) {
      if (out[k].id === a.id) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      out.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 注入依赖
// ---------------------------------------------------------------------------

/**
 * core 拿不到平台能力，全靠这套注入。
 *
 * `clientFactory` 与 `coordinator` 分开注入：协调器要工厂去建客户端做探活，
 * 而 `HarnessViewModel` 自己也要建「未认证客户端」去做配对与连接测试。
 */
export interface HarnessDeps {
  /** 主机（多电脑/多地址）存储。 */
  hostStore: HostStore;
  /** 界面偏好（busySendMode / genUiDebug / useWebChat / showContext）。 */
  preferences: AppPreferences;
  /** 连接协调器（并发探活 + 选路）。 */
  coordinator: ConnectionCoordinator;
  /** 客户端工厂（平台层实现，单测可换成假客户端）。 */
  clientFactory: DshClientFactory;
  /** 旧版单连接数据迁移要用的原始键值存储。 */
  legacyKeyValueStore: KeyValueStore;
  /** 旧版令牌用的是另一个别名，迁移时必须用它解密。 */
  legacySecretBox: SecretBox;
  /** 当前时间（毫秒）。 */
  now(): number;
  /** 生成 id（UUID 之类）。 */
  newId(): string;
  /** 当前界面语言（BCP-47）。 */
  languageTag(): string;
  /** 平台定时器（400ms 去抖与轮内等待都走它）。 */
  timers: TimerBridge;
}

// ---------------------------------------------------------------------------
// 主类
// ---------------------------------------------------------------------------

export class HarnessViewModel {
  private deps: HarnessDeps;
  /** 正在下载中的附件 id。界面每次组合都会调 loadAttachmentImage，靠它去重。 */
  private loadingAttachments: Set<string> = new Set<string>();
  /**
   * 因**授权**失败的附件 id：允许重试。
   *
   * 与 `HarnessState.attachmentFailures` 分开，是因为「记住失败」和「允许重试」两件事
   * 不能共用一个容器。
   */
  private retryableAttachmentFailures: Set<string> = new Set<string>();
  /**
   * 同步发送闸（防双击）。
   *
   * 与「禁用发送按钮」是两回事：按钮的禁用状态要等下一次重组才生效，而双击的两次点击
   * 之间完全可能一次重组都没有；这个布尔量在 `sendMessage` 的第一行就同步置起，
   * 因此第二次点击进来时已经被挡住。
   */
  private sending: boolean = false;

  /** 对外共享状态（就地改，不重建）。 */
  state: HarnessState;
  /** 每次 `update` 自增，供监听者/界面判断「变了」。 */
  revision: number = 0;
  private listeners: (() => void)[] = [];

  /**
   * 连接页门闩：**进程级**，刻意不放进 `HarnessState`。
   *
   * `HarnessState` 在三个地方被整份重建（初始、disconnect、loadSnapshot），
   * 把门闩塞进那份状态，连上之后就会被重建冲掉 —— 用户看到的是「刚进聊天页又被弹回
   * 连接页」。放这里则只有一个来源能改变它：`passConnectGate()`。
   */
  connectGate: boolean = false;

  /** 当前活跃连接。null 表示未连接。 */
  private active: ActiveConnection | null = null;
  private eventSubscription: { close(): void } | null = null;
  /**
   * 事件流是否因熄屏而主动暂停。
   *
   * 用它区分「用户主动断开」与「熄屏暂停」：前者 `active` 已被清空、不该被 resumeEvents
   * 复活；后者连接还在，亮屏就该接回去。
   */
  private eventsPaused: boolean = false;
  private chatRefreshActive: boolean = false;
  private chatRefreshPending: boolean = false;
  private chatSessionRefreshPending: boolean = false;
  private liveFinalizeTarget: LiveKey | null = null;
  /** 未触发的定时器句柄，`dispose()` 时一次性取消。 */
  private timerHandles: number[] = [];
  private disposed: boolean = false;

  constructor(deps: HarnessDeps) {
    this.deps = deps;
    this.state = new HarnessState();
    this.applyPreferences(this.state);
    // Kotlin 的 init { restoreConnection() }。
    void this.restoreConnection();
  }

  // ————————————————— 对外订阅 —————————————————

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    const self: HarnessViewModel = this;
    return (): void => {
      const at: number = self.listeners.indexOf(listener);
      if (at >= 0) {
        self.listeners.splice(at, 1);
      }
    };
  }

  private notifyListeners(): void {
    const copy: (() => void)[] = this.listeners.slice();
    for (let i = 0; i < copy.length; i++) {
      copy[i]();
    }
  }

  /**
   * 就地改状态 + `revision++` + 通知监听者（对应 Kotlin 的 `MutableStateFlow.update`）。
   */
  private update(fn: (s: HarnessState) => void): void {
    fn(this.state);
    this.revision = this.revision + 1;
    this.notifyListeners();
  }

  /** 把偏好里存着的设置盖到状态上（三处整份重建都必须调它，漏一处设置就会「变回去」）。 */
  private applyPreferences(s: HarnessState): void {
    s.busySendMode = this.deps.preferences.busySendMode;
    s.genUiDebug = this.deps.preferences.genUiDebug;
    s.useWebChat = this.deps.preferences.useWebChat;
    s.showContext = this.deps.preferences.showContext;
  }

  /** 放行连接页，进入 App（幂等）。只由用户的主动动作调用。 */
  passConnectGate(): void {
    if (this.connectGate) {
      return;
    }
    this.connectGate = true;
    // 这一行**不能省**：界面的切页判据（`Index.showConnect()`）读的就是 `vm.connectGate`，
    // 而界面重绘靠的是 `revision`（`AppStorage` 那个 `dshRevision` 键，见 AppRuntime）。
    // 源工程里它是 `MutableStateFlow`，赋值天然通知订阅者（Compose 重组）；移植成普通字段后
    // 通知语义丢了 —— 只改字段不通知，用户点「进入应用」后门闩已经放行、界面却纹丝不动，
    // 表现就是「点了没反应 / 不进入下一个页面」（真机踩坑，见 PORT-MAP 坑 19）。
    // 传空变换：本次不改任何状态字段，只需要那一次「变了」的通知。
    this.update((_s: HarnessState): void => {
    });
  }

  /** 当前活跃连接；null 表示未连接。只读暴露，供 WebView 版聊天页复用同一条链路。 */
  activeConnection(): ActiveConnection | null {
    return this.active;
  }

  private client(): DshClient | null {
    return this.active === null ? null : this.active.client;
  }

  private lang(): string {
    return this.deps.languageTag();
  }

  /** 走全局错误通道（界面层转成 snackbar）；文案在这里就已经是人话。 */
  private notify(message: string): void {
    this.update((s: HarnessState): void => {
      s.error = message;
    });
  }

  private hasScope(scope: string): boolean {
    const device: DeviceView | null = this.state.device;
    if (device === null) {
      return false;
    }
    for (let i = 0; i < device.scopes.length; i++) {
      if (device.scopes[i] === scope) {
        return true;
      }
    }
    return false;
  }

  // ————————————————— 连接管理 —————————————————

  setEndpointDraft(value: string): void {
    this.update((s: HarnessState): void => {
      s.endpointDraft = value;
      s.healthOk = false;
      s.error = null;
    });
  }

  async testConnection(endpoint: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const normalized: string = normalizeEndpoint(endpoint);
      await this.deps.clientFactory.create(normalized, null).health();
      this.update((s: HarnessState): void => {
        s.endpointDraft = stripApiSuffix(normalized);
        s.healthOk = true;
      });
    });
  }

  /**
   * 用一次性配对码把一台电脑加进来并连接。
   *
   * 配对码适合「电脑就在手边」的场合（同一局域网，或你正坐在电脑前）。
   * 人已经出门在外、看不到电脑屏幕时请改用 `importConfiguration`。
   */
  async pair(endpoint: string, code: string, deviceName: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      if (isBlank(code)) {
        throw new Error('Pairing code is required.');
      }
      if (isBlank(deviceName)) {
        throw new Error('Device name is required.');
      }
      const unauthenticated: DshClient = this.deps.clientFactory.create(endpoint, null);
      await unauthenticated.health();
      const pairing: PairingResult = await unauthenticated.pair(code, deviceName);
      const host: Host = this.hostFromPairing(unauthenticated.endpoint, pairing.token, pairing.device, deviceName);
      this.deps.hostStore.upsert(host);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
        s.selectedHostId = host.id;
      });
      await this.connectHostInternal(host, pairing.device);
    });
  }

  /**
   * 导入一段配置文本（形如 `DSH1:...`），把一台电脑加进来并连接。
   *
   * 这是取代扫码的主路径：配置文本可以在电脑上生成后发给自己，到了外面再粘贴。
   * 全程不需要电脑在旁边，也不需要摄像头。
   */
  async importConfiguration(text: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const payload: SharePayload | null = ConnectionShare.decode(text);
      if (payload === null) {
        throw new Error(CONFIG_INVALID);
      }
      const host: Host = ConnectionShare.buildHost(payload);
      this.deps.hostStore.upsert(host);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
        s.selectedHostId = host.id;
      });
      await this.connectHostInternal(host);
    });
  }

  /** 连接已保存的某台电脑：并发探活其全部地址并自动选路。 */
  async connectHost(hostId: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      this.update((s: HarnessState): void => {
        s.selectedHostId = hostId;
      });
      await this.connectHostInternal(host);
    });
  }

  /** 给某台电脑追加一个可达地址（例如新增虚拟网地址）。 */
  async addEndpoint(hostId: string, label: string, baseUrl: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      const normalized: string = stripApiSuffix(normalizeEndpoint(baseUrl));
      for (let i = 0; i < host.endpoints.length; i++) {
        if (host.endpoints[i].baseUrl === normalized) {
          return;
        }
      }
      const endpoint: Endpoint = Endpoint.create(label, normalized, `ep-${this.deps.newId()}`);
      const next: Host = host.copy();
      next.endpoints = host.endpoints.concat([endpoint]);
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  /** 删除某台电脑的一个地址。保留最后一个地址的行为由界面负责拦截。 */
  async removeEndpoint(hostId: string, endpointId: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      if (host.endpoints.length <= 1) {
        throw new Error(LAST_ENDPOINT);
      }
      const endpoints: Endpoint[] = [];
      for (let i = 0; i < host.endpoints.length; i++) {
        if (host.endpoints[i].id !== endpointId) {
          endpoints.push(host.endpoints[i]);
        }
      }
      let preferred: string | null = host.preferredEndpointId;
      if (preferred !== null) {
        let found: boolean = false;
        for (let i = 0; i < endpoints.length; i++) {
          if (endpoints[i].id === preferred) {
            found = true;
            break;
          }
        }
        if (!found) {
          preferred = null;
        }
      }
      const next: Host = host.copy();
      next.endpoints = endpoints;
      next.preferredEndpointId = preferred;
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  /** 重命名一台电脑。 */
  async renameHost(hostId: string, displayName: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      const next: Host = host.copy();
      next.displayName = trimText(displayName);
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  /**
   * 删除一台电脑（含其凭据）。
   *
   * 与 `disconnect` 分开：断开只是断连，删除才是抹掉令牌。
   */
  removeHost(hostId: string): void {
    if (this.state.activeHostId === hostId) {
      this.disconnect();
    }
    this.deps.hostStore.remove(hostId);
    this.update((s: HarnessState): void => {
      s.hosts = this.deps.hostStore.loadHosts();
      s.selectedHostId = s.selectedHostId === hostId ? null : s.selectedHostId;
    });
  }

  selectHost(hostId: string | null): void {
    this.update((s: HarnessState): void => {
      s.selectedHostId = hostId;
    });
  }

  /**
   * 把当前连接状态落回主机记录：探活结果 + 实际选中的地址。
   */
  private async connectHostInternal(host: Host, device: DeviceView | null = null): Promise<void> {
    console.info('[DSH] connect start ' + host.id);
    this.update((s: HarnessState): void => {
      s.connecting = true;
      s.endpointProbes = [];
      s.error = null;
    });
    let connection: ActiveConnection;
    try {
      connection = await this.deps.coordinator.connect(host);
    } catch (failure) {
      const probes: EndpointProbe[] = failure instanceof DshConnectionException ? failure.probes : [];
      if (probes.length > 0) {
        this.deps.hostStore.upsert(this.applyProbes(host, probes));
      }
      this.update((s: HarnessState): void => {
        s.connecting = false;
        // 冷启动的自动重连失败走的正是这条路，而它是**正常返回**（不抛异常），
        // 所以 restoreConnection 的兜底接不住 —— 不在这里复位，restoring 会一直停在 true。
        s.restoring = false;
        s.hosts = this.deps.hostStore.loadHosts();
        s.endpointProbes = probes;
        s.error = this.messageOf(failure as Object);
      });
      return;
    }
    console.info('[DSH] connect probed, endpoint=' + connection.endpoint.id);
    const recorded: Host = this.applyProbes(connection.host, connection.probes)
      .withPreferred(connection.endpoint.id);
    this.deps.hostStore.upsert(recorded);
    // 探测成功 ≠ 连接完成：取设备信息与拉快照是普通 HTTP，**同样可能失败**。这两步若抛
    // 异常而只靠外层（launchOperation / restoreConnection）兜底，外层不会复位 `connecting`
    // —— UI 就永远停在「正在探测 N 个地址…」、连接按钮一直禁用（真机踩坑，见 PORT-MAP
    // 坑 18）。所以在这里就地收口：失败也把连接态复位干净。
    try {
      const resolved: DeviceView = device !== null ? device : await connection.client.currentDevice();
      console.info('[DSH] connect device ok scopes=' + resolved.scopes.join(','));
      const snapshot: HarnessState = await this.loadSnapshot(connection.client, resolved);
      console.info('[DSH] connect snapshot ok');
      this.active = connection;
      this.update((s: HarnessState): void => {
        s.copyFrom(snapshot);
        s.restoring = false;
        s.busy = true;
        s.connecting = false;
        s.connected = true;
        s.healthOk = true;
        s.hosts = this.deps.hostStore.loadHosts();
        s.activeHostId = recorded.id;
        s.activeEndpointId = connection.endpoint.id;
        s.endpointProbes = connection.probes;
      });
    } catch (failure) {
      console.error('[DSH] connect post-probe FAIL: ' + String(failure));
      this.active = null;
      this.update((s: HarnessState): void => {
        s.restoring = false;
        s.connecting = false;
        s.connected = false;
        s.error = this.messageOf(failure as Object);
      });
      return;
    }
    console.info('[DSH] connect done, opening events');
    this.connectEvents(connection.client);
    // 走到这里连接已完全就绪（设备信息 / 快照 / 事件流都到位），`busy` 的语义「有请求在跑」
    // 不再成立，必须复位。不复位的话冷启动自动重连（`restoreConnection` 直接调用本方法、
    // **没有** launchOperation 那层收尾）会把 `busy = true` 一直留给用户：连接页的
    // 🗑「删除」是灰的、主界面会话列表每一行也点不动（它们的 enabled 都含 `!state.busy`）
    // —— 用户看到的就是「删除连接信息点了没反应」（真机踩坑，见 PORT-MAP 坑 19）。
    // 手动连接那条路有 launchOperation 兜尾，这里再置一次是同值、无副作用。
    this.update((s: HarnessState): void => {
      s.busy = false;
    });
  }

  private applyProbes(host: Host, probes: EndpointProbe[]): Host {
    let acc: Host = host;
    for (let i = 0; i < probes.length; i++) {
      const p: EndpointProbe = probes[i];
      acc = acc.withEndpointProbe(p.endpointId, p.latencyMs, p.error, this.deps.now());
    }
    return acc;
  }

  private hostFromPairing(endpoint: string, token: string, device: DeviceView,
                          displayName: string): Host {
    const now: number = this.deps.now();
    const baseUrl: string = stripApiSuffix(normalizeEndpoint(endpoint));
    const endpointId: string = 'ep-paired';
    const hosts: Host[] = this.deps.hostStore.loadHosts();
    let existing: Host | null = null;
    for (let i = 0; i < hosts.length; i++) {
      if (hosts[i].id === `host-${device.id}`) {
        existing = hosts[i];
        break;
      }
    }
    const trimmed: string = trimText(displayName);
    // 主机名优先用用户填的设备名，其次是电脑自己报的名字（对应 Kotlin 的 orEmpty 兜底）。
    const finalName: string = trimmed.length > 0 ? trimmed : device.name;
    // `Endpoint.create` 会在 label 为空时退回 baseUrl，所以这里直接拿主机名当标签。
    const issuedAt: number = existing !== null && existing.credential !== null && existing.credential.issuedAt > 0
      ? existing.credential.issuedAt : now;
    const credential: Credential = new Credential(CredentialKind.DEVICE_TOKEN, token, device.id,
      device.name, device.scopes, issuedAt, null);
    return new Host(`host-${device.id}`, finalName,
      [Endpoint.create(finalName, baseUrl, endpointId)], endpointId, credential,
      existing !== null ? existing.createdAt : now, now);
  }

  /**
   * 断开当前连接。
   *
   * 注意**不再清除已保存的主机**：旧实现把「断开」和「删除令牌」绑成一个动作，
   * 于是网络抖一下、手点错一次，用户就得重新配对 —— 而配对又要求电脑在身边。
   */
  disconnect(): void {
    if (this.eventSubscription !== null) {
      this.eventSubscription.close();
      this.eventSubscription = null;
    }
    // 手动断开要清掉熄屏暂停标志：否则下次亮屏 resumeEvents 会把用户刚刚主动断开的
    // 连接又接回去 —— 那是最容易让人以为「断开没用」的 bug。
    this.eventsPaused = false;
    this.active = null;
    const next: HarnessState = new HarnessState();
    next.restoring = false;
    next.hosts = this.deps.hostStore.loadHosts();
    this.applyPreferences(next);
    this.state.copyFrom(next);
    this.revision = this.revision + 1;
    this.notifyListeners();
  }

  clearError(): void {
    this.update((s: HarnessState): void => {
      s.error = null;
    });
  }

  async refreshDashboard(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const device: DeviceView = await api.currentDevice();
      const snapshot: HarnessState = await this.loadSnapshot(api, device);
      const prevSessionId: string | null = this.state.selectedSessionId;
      const prevRootId: string | null = this.state.selectedRootId;
      this.update((s: HarnessState): void => {
        s.copyFrom(snapshot);
        s.restoring = false;
        s.busy = true;
        let keepSession: boolean = false;
        if (prevSessionId !== null) {
          for (let i = 0; i < snapshot.sessions.length; i++) {
            if (snapshot.sessions[i].id === prevSessionId) {
              keepSession = true;
              break;
            }
          }
        }
        s.selectedSessionId = keepSession ? prevSessionId : null;
        let rootOk: boolean = false;
        if (prevRootId !== null) {
          for (let i = 0; i < snapshot.roots.length; i++) {
            if (snapshot.roots[i].id === prevRootId) {
              rootOk = true;
              break;
            }
          }
        }
        s.selectedRootId = rootOk ? prevRootId
          : (snapshot.roots.length > 0 ? snapshot.roots[0].id : null);
      });
    });
  }

  // ————————————————— 会话 —————————————————

  async selectSession(id: string | null): Promise<void> {
    this.update((s: HarnessState): void => {
      s.selectedSessionId = id;
      s.history = null;
      s.liveChat = null;
      s.sessionModels = null;
      s.commands = [];
      s.approvalState = id === null ? ApprovalUiState.none() : ApprovalUiState.loading();
      // 换会话就把问答状态清干净：上一组的草稿/已答标记留在界面上会张冠李戴。
      s.questions = [];
      s.answeringCallId = null;
      s.answeredCallIds = new Set<string>();
      // `@` 补全的文件列表属于**上一个会话的工作目录**，换会话必须清掉。
      s.mentionEntries = null;
      s.mentionFailed = false;
    });
    if (id !== null) {
      await this.refreshHistory();
      await this.refreshSessionModels();
      await this.refreshPendingApprovals();
      await this.refreshCommands();
      // 进会话就顺手把工作目录的文件捞回来，等用户打 `@` 时直接可用。
      await this.loadMentionEntries();
    }
  }

  async refreshHistory(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const history: ChatHistory = await api.history(id);
      this.update((s: HarnessState): void => {
        s.history = history;
      });
      // 顺手把待答问题也拉一次：顶栏刷新正是用户遇到「卡片该出现却没出现」时唯一的自救入口。
      await this.refreshPendingQuestions();
    });
  }

  async loadOlderHistory(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const current: ChatHistory | null = this.state.history;
      if (current === null) {
        return;
      }
      if (!current.hasMore) {
        return;
      }
      let beforeSeq: number | null = null;
      for (let i = 0; i < current.events.length; i++) {
        const seq: number = current.events[i].event.seq;
        if (beforeSeq === null || seq < beforeSeq) {
          beforeSeq = seq;
        }
      }
      if (beforeSeq === null) {
        return;
      }
      const older: ChatHistory = await api.history(id, beforeSeq);
      this.update((s: HarnessState): void => {
        const currentNow: ChatHistory | null = s.history;
        if (currentNow === null) {
          return;
        }
        const seen: Set<number> = new Set<number>();
        const merged: HistoryEntry[] = [];
        for (let i = 0; i < older.events.length; i++) {
          const e: HistoryEntry = older.events[i];
          if (!seen.has(e.event.seq)) {
            seen.add(e.event.seq);
            merged.push(e);
          }
        }
        for (let i = 0; i < currentNow.events.length; i++) {
          const e: HistoryEntry = currentNow.events[i];
          if (!seen.has(e.event.seq)) {
            seen.add(e.event.seq);
            merged.push(e);
          }
        }
        const projections = currentNow.projections !== null ? currentNow.projections : older.projections;
        s.history = currentNow.withOlder(merged, older.hasMore, projections);
      });
    });
  }

  /**
   * 打开会话里提到的一个文件（服务器绝对路径）。
   *
   * 分两步：先用服务端的 `roots/resolve` 把绝对路径换成「授权根 + 相对路径」，再把内容
   * 取回来。成功时顺带把「文件」页也切到这个文件。
   */
  async openSessionFile(absolutePath: string): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const sessionId: string | null = this.state.selectedSessionId;
    if (sessionId === null) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.sessionFileOpen = new SessionFileOpen(sessionId, absolutePath);
    });
    let outcome: SessionFileOutcome | null = null;
    let failure: Object | null = null;
    try {
      outcome = await this.loadSessionFile(api, sessionId, absolutePath);
    } catch (e) {
      failure = e as Object;
    }
    // 用户可能在读取期间切了会话；结果只对发起它的那个会话有效。
    if (this.state.selectedSessionId !== sessionId) {
      return;
    }
    if (outcome !== null) {
      const opened: SessionFileOutcome = outcome;
      this.update((s: HarnessState): void => {
        s.sessionFileOpen = opened.open;
        s.selectedRootId = opened.rootId !== null ? opened.rootId : s.selectedRootId;
        s.currentPath = opened.currentPath !== null ? opened.currentPath : s.currentPath;
        s.document = opened.document !== null ? opened.document : s.document;
      });
    } else {
      let text: string;
      // 端点不存在几乎只有一个原因：服务端插件版本过旧。这条提示必须可操作（去升级插件）。
      if (failure instanceof DshApiException && failure.code === 'ROUTE_NOT_FOUND') {
        text = PLUGIN_TOO_OLD;
      } else {
        text = this.messageOf(failure);
      }
      this.update((s: HarnessState): void => {
        s.sessionFileOpen = new SessionFileOpen(sessionId, absolutePath, false, null, null, null,
          false, false, false, text);
      });
    }
  }

  /**
   * 把「文件」页定位到某个目录（已经解析好的授权根 + 相对路径）。
   *
   * 与 [openSessionFile] 的分工：那个方法服务的是**会话里那个文件面板**（要开详情、
   * 要能显示「这是目录」「超出授权根」这些说明），本方法服务的是**「文件」页**（要的是就地浏览）。
   *
   * 两件事必须都做，少一件就是本文档里记的那个坑：
   * 1. 写 `selectedRootId` / `currentPath` —— 否则切过去还在原来那个目录；
   * 2. **真的把目录读出来**（`loadDirectory`）—— `roots/resolve` 只回答"是个目录"，
   *    不给目录内容；只改路径不读列表，用户切过去看到的是上一个目录的旧列表，
   *    比不切还糟（像是点错了目录）。
   */
  async revealDirectory(rootId: string, path: string): Promise<void> {
    if (rootId.length === 0 || path.length === 0) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.selectedRootId = rootId;
      s.currentPath = path;
    });
    await this.loadDirectory(path);
  }

  /** 关闭面板里的文件详情，回到路径列表。 */
  closeSessionFile(): void {
    this.update((s: HarnessState): void => {
      s.sessionFileOpen = null;
    });
  }

  private async loadSessionFile(api: DshClient, sessionId: string, absolutePath: string): Promise<SessionFileOutcome> {
    const resolved: ResolvedPath | null = await api.resolvePath(absolutePath);
    if (resolved === null) {
      return new SessionFileOutcome(
        new SessionFileOpen(sessionId, absolutePath, false, null, null, null, false, false, true, null));
    }
    const parent: string = substringBeforeLast(resolved.path, '/');
    if (resolved.kind === 'directory') {
      // 目录没有可预览的内容；但把「文件」页切过去，用户就能就地浏览。
      return new SessionFileOutcome(new SessionFileOpen(sessionId, absolutePath, false, resolved),
        resolved.rootId, resolved.path, null);
    }
    const entry: FileEntry = await this.sessionFileEntry(api, resolved, parent);
    // 图片 / PDF 与文本的上限不同：2 MiB 对一张手机截图太紧，但解码前整份字节要进内存。
    const provisional: PreviewKind = previewKind(resolved.path, resolved.contentType);
    const capRaw: number | null = binaryPreviewByteLimit(provisional);
    const cap: number = capRaw !== null ? capRaw : MAX_EDIT_BYTES;
    const tooLarge: boolean = entry.size > cap;
    const content: FileContent | null = tooLarge ? null : await api.readFile(resolved.rootId, resolved.path);
    const kind: PreviewKind = previewKindOf(resolved.path, resolved.contentType, content !== null ? content.bytes : null);
    const binary: boolean = kind === PreviewKind.IMAGE || kind === PreviewKind.PDF;
    // 图片 / PDF 不解 UTF-8：那是白费一次解码，还会把二进制变成一屏替换字符。
    const decoded: DecodedText | null = binary ? null : (content !== null ? decodeUtf8(content.bytes) : null);
    const text: string | null = decoded !== null ? decoded.text : null;
    const previewText: string | null = text !== null
      ? text.substring(0, text.length > PREVIEW_CHARS ? PREVIEW_CHARS : text.length) : null;
    const docBytes: Uint8Array | null = binary && content !== null ? content.bytes : null;
    return new SessionFileOutcome(
      new SessionFileOpen(sessionId, absolutePath, false, resolved, previewText, docBytes,
        text !== null && text.length > PREVIEW_CHARS, tooLarge, false, null),
      resolved.rootId, parent,
      new OpenDocument(entry, text, content !== null ? content.etag : '',
        decoded !== null ? decoded.hasBom : false, decoded !== null ? decoded.lineEnding : '\n',
        content !== null ? content.contentType : null, docBytes, false));
  }

  /**
   * `roots/resolve` 只说「是文件还是目录、多大、何时改」，**没有 writable**，而「文件」页
   * 的保存按钮正是看这个字段。目录列表能给出权威值，所以优先取列表里的那一条；列表读不到
   * 时退回保守构造：`writable = false`。
   */
  private async sessionFileEntry(api: DshClient, resolved: ResolvedPath, parent: string): Promise<FileEntry> {
    let listed: FileEntry | null = null;
    try {
      const page: DirectoryPage = await api.entries(resolved.rootId, parent);
      for (let i = 0; i < page.entries.length; i++) {
        if (page.entries[i].path === resolved.path) {
          listed = page.entries[i];
          break;
        }
      }
    } catch (e) {
      listed = null;
    }
    if (listed !== null) {
      return listed;
    }
    const entry: FileEntry = new FileEntry();
    const tail: string = substringAfterLast(resolved.path, '/');
    entry.name = tail.length > 0 ? tail : resolved.path;
    entry.path = resolved.path;
    entry.kind = resolved.kind;
    entry.size = resolved.size !== null ? resolved.size : 0;
    entry.modifiedAt = resolved.modifiedAt;
    entry.writable = false;
    return entry;
  }

  async createSession(workspaceId: string, preset: string | null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const created: CreatedSession = await api.createSession(workspaceId,
        preset !== null && isNotBlank(preset) ? preset : null);
      const sessions: ChatSession[] = await api.sessions();
      const history: ChatHistory = await api.history(created.id);
      const models: SessionModels = await api.sessionModels(created.id);
      const commands: CommandDescriptor[] = await api.sessionCommands(created.id);
      this.update((s: HarnessState): void => {
        s.sessions = sessions;
        s.selectedSessionId = created.id;
        s.history = history;
        s.sessionModels = models;
        s.commands = commands;
        s.approvalState = ApprovalUiState.none();
      });
    });
  }

  async prepareWorkspacePicker(): Promise<void> {
    let rootId: string | null = this.state.workspacePickerRootId;
    if (rootId !== null) {
      let found: boolean = false;
      for (let i = 0; i < this.state.roots.length; i++) {
        if (this.state.roots[i].id === rootId) {
          found = true;
          break;
        }
      }
      if (!found) {
        rootId = null;
      }
    }
    if (rootId === null) {
      rootId = this.state.selectedRootId;
    }
    if (rootId === null) {
      rootId = this.state.roots.length > 0 ? this.state.roots[0].id : null;
    }
    const chosen: string | null = rootId;
    this.update((s: HarnessState): void => {
      s.workspacePickerRootId = chosen;
      s.workspacePickerPath = '';
      s.workspacePickerDirectory = null;
    });
    if (chosen !== null) {
      await this.loadWorkspacePickerDirectory('');
    }
  }

  async selectWorkspacePickerRoot(rootId: string): Promise<void> {
    this.update((s: HarnessState): void => {
      s.workspacePickerRootId = rootId;
      s.workspacePickerPath = '';
      s.workspacePickerDirectory = null;
    });
    await this.loadWorkspacePickerDirectory('');
  }

  async loadWorkspacePickerDirectory(path: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const rootId: string | null = this.state.workspacePickerRootId;
      if (rootId === null) {
        return;
      }
      const normalized: string = trimChar(path, '/');
      const page: DirectoryPage = await api.entries(rootId, normalized);
      this.update((s: HarnessState): void => {
        s.workspacePickerPath = normalized;
        s.workspacePickerDirectory = page;
      });
    });
  }

  async createWorkspaceAndSession(rootId: string, path: string, preset: string | null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const workspace: ChatWorkspace = await api.createChatWorkspace(rootId, trimChar(path, '/'));
      const created: CreatedSession = await api.createSession(workspace.id,
        preset !== null && isNotBlank(preset) ? preset : null);
      const sessions: ChatSession[] = await api.sessions();
      const workspaces: ChatWorkspace[] = await api.chatWorkspaces();
      const history: ChatHistory = await api.history(created.id);
      const models: SessionModels = await api.sessionModels(created.id);
      const commands: CommandDescriptor[] = await api.sessionCommands(created.id);
      this.update((s: HarnessState): void => {
        s.chatWorkspaces = workspaces;
        s.sessions = sessions;
        s.selectedSessionId = created.id;
        s.history = history;
        s.sessionModels = models;
        s.commands = commands;
        s.approvalState = ApprovalUiState.none();
      });
    });
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.renameChatWorkspace(workspaceId, title);
      const workspaces: ChatWorkspace[] = await api.chatWorkspaces();
      const sessions: ChatSession[] = await api.sessions();
      this.update((s: HarnessState): void => {
        s.chatWorkspaces = workspaces;
        s.sessions = sessions;
      });
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.deleteChatWorkspace(workspaceId);
      const workspaces: ChatWorkspace[] = await api.chatWorkspaces();
      const sessions: ChatSession[] = await api.sessions();
      this.update((s: HarnessState): void => {
        s.chatWorkspaces = workspaces;
        s.sessions = sessions;
      });
    });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.renameSession(sessionId, title);
      const sessions: ChatSession[] = await api.sessions();
      this.update((s: HarnessState): void => {
        s.sessions = sessions;
      });
    });
  }

  async forkSession(sessionId: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const forkedId: string = await api.forkSession(sessionId);
      const sessions: ChatSession[] = await api.sessions();
      const history: ChatHistory = await api.history(forkedId);
      const models: SessionModels = await api.sessionModels(forkedId);
      const commands: CommandDescriptor[] = await api.sessionCommands(forkedId);
      this.update((s: HarnessState): void => {
        s.sessions = sessions;
        s.selectedSessionId = forkedId;
        s.history = history;
        s.sessionModels = models;
        s.commands = commands;
        s.approvalState = ApprovalUiState.none();
        s.liveChat = null;
      });
    });
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.archiveSession(sessionId);
      const sessions: ChatSession[] = await api.sessions();
      this.update((s: HarnessState): void => {
        if (s.selectedSessionId === sessionId) {
          s.sessions = sessions;
          s.selectedSessionId = null;
          s.history = null;
          s.liveChat = null;
          s.sessionModels = null;
          s.commands = [];
          s.approvalState = ApprovalUiState.none();
        } else {
          s.sessions = sessions;
        }
      });
    });
  }

  // ————————————————— 发送与附件 —————————————————

  /**
   * 发一条消息：文本 + 待发附件一起组装成 content 数组。
   *
   * `/命令` 分支只在不带附件时走 —— 命令是发给宿主的一行文本，附件跟着它没有意义；
   * 带附件时按普通消息发。
   *
   * 防重复提交靠的是**在调用线程上同步**「置闸 + 取走并清空待发内容」，**不是**靠禁用按钮：
   * 按钮的禁用状态要等下一次重组才生效，而双击的两次点击之间完全可能一次重组都没有 ——
   * 于是同一条消息（连同同一张图）发两遍。所以闸与清空必须在**任何 await 之前**同步完成；
   * 光清空附件还不够（纯文本消息没有附件可清），所以另设一个同步的 `sending` 闸兜底。
   * 之所以不能把取状态留到 await 之后做：第二次点击可能抢在它前面读到同一批附件。
   * 发送失败时把附件**与文字**一起还回输入区。
   */
  async sendMessage(text: string, steer: boolean): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    // ⚠️ 同步置闸：这一行与下面的清空都必须早于**任何 await**。
    if (this.sending) {
      return;
    }
    this.sending = true;
    try {
      // 同步取走待发附件（引用即可，不逐条拷贝）。
      const attachments: PendingAttachment[] = this.state.pendingAttachments;
      const line: string = trimEndText(text);
      if (attachments.length === 0 && isHostCommandLine(line, this.state.commands)) {
        await this.launchOperation(async (): Promise<void> => {
          const execution: CommandExecution = await api.executeCommand(id, line);
          if (execution.result.kind === 'error') {
            throw new DshApiException(409, COMMAND_FAILED,
              execution.result.text !== null ? execution.result.text : 'Command failed.');
          }
          const history: ChatHistory = await api.history(id);
          const commands: CommandDescriptor[] = await api.sessionCommands(id);
          this.update((s: HarnessState): void => {
            s.history = history;
            s.commands = commands;
          });
        });
        return;
      }
      const parts: PromptPart[] = [];
      if (isNotBlank(text)) {
        parts.push(PromptPart.text(text));
      }
      for (let i = 0; i < attachments.length; i++) {
        parts.push(attachments[i].part);
      }
      if (parts.length === 0) {
        return;
      }
      // 清空在这里做，但**原文记在局部变量里**：失败时才写回 pendingText。
      // 写成「提交时就存进 state」的话，UI 监听 pendingText 会把刚提交的正文立刻塞回输入框，
      // 用户看着就像「发了又没发」。
      this.update((s: HarnessState): void => {
        s.pendingAttachments = [];
        s.pendingText = '';
      });
      await this.launchOperation(async (): Promise<void> => {
        try {
          await api.sendMessage(id, parts, steer);
        } catch (failure) {
          // 把附件与文字都放回输入区；期间新加的条目按 id 去重，不重复。
          this.update((s: HarnessState): void => {
            s.pendingAttachments = distinctById(attachments.concat(s.pendingAttachments));
            s.pendingText = text;
          });
          this.notify(toastText('send_failed_restore', this.lang(), this.describeSendFailure(failure as Object)));
          throw failure;
        }
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
      });
    } finally {
      // 无论成功、失败还是提前返回，闸都要在**这一轮结束**时放开。
      this.sending = false;
    }
  }

  /**
   * 把发送失败翻译成一句用户看得懂的话。
   *
   * 直接把 `BODY_INVALID: text is required.` 甩到屏幕上，用户能做的只有 staring。
   */
  private describeSendFailure(failure: Object): string {
    const raw: string = this.messageOf(failure);
    if (raw.indexOf('401') >= 0 || raw.indexOf('TOKEN') >= 0) {
      return toastText('send_failed_auth', this.lang());
    }
    if (raw.indexOf('413') >= 0 || raw.indexOf('too large') >= 0) {
      return toastText('send_failed_too_large', this.lang());
    }
    if (raw.indexOf('BODY_INVALID') >= 0) {
      return toastText('send_failed_body', this.lang());
    }
    return raw;
  }

  /**
   * 把选中的图片内联进「待发附件」。
   *
   * 图片不走上传端点（内核的 image part 直接带 base64），所以这里唯一要防的就是体积：
   * 超限当场拒绝并给出可照做的提示，而不是等一个 413。
   *
   * 平台层已按 `MAX_IMAGE_BYTES + 1` 读好字节；这里只按 `bytes.length` 判定。
   */
  async attachImage(name: string, mediaType: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > MAX_IMAGE_BYTES) {
      this.notify(toastText('attachment_image_too_large', this.lang(), formatBytes(MAX_IMAGE_BYTES)));
      return;
    }
    let part: PromptPart;
    try {
      part = imagePart(mediaType, bytes, name);
    } catch (e) {
      this.notify(toastText('attachment_image_too_large', this.lang(), formatBytes(MAX_IMAGE_BYTES)));
      return;
    }
    this.update((s: HarnessState): void => {
      s.pendingAttachments = s.pendingAttachments.concat([
        new PendingAttachment(this.deps.newId(), part, name, bytes.length, bytes),
      ]);
    });
  }

  /**
   * 上传选中的文件，换回 `receiptId` 后放进「待发附件」。
   *
   * 上传是网络动作，单独一个 `attachmentUploading` 只用于显示进度；**不**参与发送键的
   * 可用性判断。
   */
  async attachFile(name: string, bytes: Uint8Array): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const sessionId: string | null = this.state.selectedSessionId;
    if (sessionId === null) {
      return;
    }
    if (bytes.length > MAX_FILE_BYTES) {
      this.notify(toastText('attachment_file_too_large', this.lang(), formatBytes(MAX_FILE_BYTES)));
      return;
    }
    this.update((s: HarnessState): void => {
      s.attachmentUploading = true;
    });
    try {
      const uploaded: UploadedAttachment = await api.uploadAttachment(sessionId, bytes, name);
      // 上传期间用户可能换了会话：附件属于发起它的那条会话，别塞到别的会话里。
      if (this.state.selectedSessionId !== sessionId) {
        return;
      }
      this.update((s: HarnessState): void => {
        s.pendingAttachments = s.pendingAttachments.concat([
          new PendingAttachment(this.deps.newId(), PromptPart.file(uploaded.receiptId),
            isBlank(uploaded.name) ? name : uploaded.name, bytes.length, null),
        ]);
      });
    } catch (failure) {
      let text: string;
      // 服务端的上限可能比客户端更严；这时不能引用我们自己的 24 MiB，否则用户会被
      // 「明明没到 24 MiB」搞糊涂。
      if (failure instanceof DshApiException && failure.code === 'TOO_LARGE') {
        text = toastText('attachment_file_rejected', this.lang());
      } else if (failure instanceof DshApiException && failure.code === 'ROUTE_NOT_FOUND') {
        text = toastText('attachment_upload_unsupported', this.lang());
      } else {
        text = this.messageOf(failure as Object);
      }
      this.update((s: HarnessState): void => {
        s.error = text;
      });
    } finally {
      this.update((s: HarnessState): void => {
        s.attachmentUploading = false;
      });
    }
  }

  /** 从待发附件里删掉一条。 */
  removePendingAttachment(id: string): void {
    this.update((s: HarnessState): void => {
      const out: PendingAttachment[] = [];
      for (let i = 0; i < s.pendingAttachments.length; i++) {
        if (s.pendingAttachments[i].id !== id) {
          out.push(s.pendingAttachments[i]);
        }
      }
      s.pendingAttachments = out;
    });
  }

  /** 清空待发附件（例如用户放弃了这条消息）。 */
  clearPendingAttachments(): void {
    this.update((s: HarnessState): void => {
      s.pendingAttachments = [];
    });
  }

  /** 当前选中的会话是否正在运行（决定「排队 / 插话」有没有区别）。 */
  selectedSessionRunning(): boolean {
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return false;
    }
    return this.isSessionRunning(id);
  }

  /**
   * 这个会话是否正在运行。
   *
   * 刻意不限于「当前选中的会话」：`chat.turn.end` 判「这一轮刚结束」时用的是事件里的那个
   * sessionId —— 它可能不是当前正在看的那个。会话列表里查不到时**返回 false**。
   */
  private isSessionRunning(sessionId: string): boolean {
    const sessions: ChatSession[] = this.state.sessions;
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId) {
        return sessions[i].running === true;
      }
    }
    return false;
  }

  /** 改「智能体运行时」的默认提交行为，并立刻落盘（下次启动保持）。 */
  setBusySendMode(mode: string): void {
    this.deps.preferences.busySendMode = mode;
    this.update((s: HarnessState): void => {
      s.busySendMode = mode;
    });
  }

  /** 会话详情页是否走 WebView 版。立刻生效，不需要重启。 */
  setUseWebChat(enabled: boolean): void {
    this.deps.preferences.useWebChat = enabled;
    this.update((s: HarnessState): void => {
      s.useWebChat = enabled;
    });
  }

  /** 聊天页是否显示「上下文注入」块。 */
  setShowContext(enabled: boolean): void {
    this.deps.preferences.showContext = enabled;
    this.update((s: HarnessState): void => {
      s.showContext = enabled;
    });
  }

  /** 开关 dsh-ui 诊断行；立刻生效，不需要重启。 */
  setGenUiDebug(enabled: boolean): void {
    this.deps.preferences.genUiDebug = enabled;
    this.update((s: HarnessState): void => {
      s.genUiDebug = enabled;
    });
  }

  /**
   * 按需取回一张会话图片。
   *
   * **两种来源、两条读法**，前缀就是判据：
   * - 原生附件（模型支持图片输入）：字节在服务端附件存储里，走 `readAttachment`，
   *   必须带当前会话 id；
   * - 交接图片（纯文本模型发图时插件落进工作区 `.dsh-images/` 的文件）：字节根本不在
   *   附件存储里，走官方那条「绝对路径 → 授权根」的解析与读文件，与会话无关。
   *
   * 幂等且可反复调用：已缓存的直接返回，正在取的会被 `loadingAttachments` 挡住，
   * 取失败的连同**原因**记进 `attachmentFailures` 不再重试（授权类失败除外）。
   */
  async loadAttachmentImage(attachmentId: string): Promise<void> {
    if (isBlank(attachmentId)) {
      return;
    }
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const current: HarnessState = this.state;
    // 交接图的 id 本身就是一条服务器绝对路径。
    const handoffPath: string | null = handoffPathOf(attachmentId);
    const sessionId: string | null = current.selectedSessionId;
    if (handoffPath === null && (sessionId === null || isBlank(sessionId))) {
      return;
    }
    if (current.attachmentImages.has(attachmentId)) {
      return;
    }
    // 授权类失败**不永久记住**：用户重新配对之后图就该能显示。附件真的没了（404）才记死。
    if (current.attachmentFailures.has(attachmentId) && !this.retryableAttachmentFailures.has(attachmentId)) {
      return;
    }
    if (this.loadingAttachments.has(attachmentId)) {
      return;
    }
    this.loadingAttachments.add(attachmentId);
    let bytes: Uint8Array | null = null;
    let failure: Object | null = null;
    try {
      if (handoffPath !== null) {
        bytes = await this.readHandoffImage(api, handoffPath);
      } else {
        bytes = await api.readAttachment(sessionId as string, attachmentId);
      }
    } catch (e) {
      failure = e as Object;
    }
    this.loadingAttachments.delete(attachmentId);
    if (bytes !== null) {
      const imageBytes: Uint8Array = bytes;
      this.update((s: HarnessState): void => {
        const images: Map<string, Uint8Array> = new Map<string, Uint8Array>();
        s.attachmentImages.forEach((v: Uint8Array, k: string): void => {
          images.set(k, v);
        });
        images.set(attachmentId, imageBytes);
        const failures: Map<string, string> = new Map<string, string>();
        s.attachmentFailures.forEach((v: string, k: string): void => {
          if (k !== attachmentId) {
            failures.set(k, v);
          }
        });
        s.attachmentImages = images;
        s.attachmentFailures = failures;
      });
      this.retryableAttachmentFailures.delete(attachmentId);
    } else if (failure !== null) {
      const reason: string = this.describeAttachmentFailure(failure);
      if (this.isRetryableAttachmentFailure(failure)) {
        this.retryableAttachmentFailures.add(attachmentId);
      }
      this.update((s: HarnessState): void => {
        const failures: Map<string, string> = new Map<string, string>();
        s.attachmentFailures.forEach((v: string, k: string): void => {
          failures.set(k, v);
        });
        failures.set(attachmentId, reason);
        s.attachmentFailures = failures;
      });
    }
  }

  /**
   * 读一张**交接图片**（纯文本模型发图时落进会话工作区 `.dsh-images/` 的那份）。
   *
   * 用官方那条现成的路：`resolvePath` 把服务器绝对路径解析成「授权根 + 相对路径」，
   * 再 `readFile` 取字节。解析不出来就按失败上报。
   */
  private async readHandoffImage(api: DshClient, path: string): Promise<Uint8Array> {
    const resolved: ResolvedPath | null = await api.resolvePath(path);
    if (resolved === null) {
      throw new DshApiException(404, 'PATH_OUTSIDE_ROOTS', `PATH_OUTSIDE_ROOTS: ${path}`);
    }
    const content: FileContent = await api.readFile(resolved.rootId, resolved.path);
    return content.bytes;
  }

  /**
   * 这类失败在重新配对后可能自愈，因此允许重试。
   *
   * 判据是**病因**而不是错误码：401/403 是授权状态问题，换一次配对就好了；
   * 404 是服务端确实没有这份字节，再试一百次也一样。
   */
  private isRetryableAttachmentFailure(failure: Object): boolean {
    const raw: string = this.messageOf(failure);
    return raw.indexOf('401') >= 0 || raw.indexOf('403') >= 0 || raw.indexOf('TOKEN') >= 0
      || raw.indexOf('SCOPE') >= 0 || raw.indexOf('FORBIDDEN') >= 0;
  }

  /** 把取图失败翻译成一句能照做的提示。 */
  private describeAttachmentFailure(failure: Object): string {
    const raw: string = this.messageOf(failure);
    if (raw.indexOf('PATH_OUTSIDE_ROOTS') >= 0 || raw.indexOf('PATH_NOT_FOUND') >= 0
      || raw.indexOf('PATH_NOT_ABSOLUTE') >= 0) {
      return toastText('attachment_fail_outside_roots', this.lang());
    }
    if (raw.indexOf('401') >= 0 || raw.indexOf('TOKEN') >= 0) {
      return toastText('attachment_fail_auth', this.lang());
    }
    if (raw.indexOf('403') >= 0 || raw.indexOf('SCOPE') >= 0 || raw.indexOf('FORBIDDEN') >= 0) {
      return toastText('attachment_fail_scope', this.lang());
    }
    if (raw.indexOf('404') >= 0 || raw.indexOf('NOT_FOUND') >= 0) {
      return toastText('attachment_fail_missing', this.lang());
    }
    return toastText('attachment_fail_other', this.lang(), raw);
  }

  // ————————————————— 命令 / 模型 / 供应商 / 插件 —————————————————

  async refreshCommands(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const commands: CommandDescriptor[] = await api.sessionCommands(id);
      this.update((s: HarnessState): void => {
        s.commands = commands;
      });
    });
  }

  async selectPermissionPreset(preset: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const execution: CommandExecution = await api.executeCommand(id, `/permission ${preset}`);
      if (execution.result.kind === 'error') {
        throw new DshApiException(409, COMMAND_FAILED,
          execution.result.text !== null ? execution.result.text : 'Permission change failed.');
      }
      const history: ChatHistory = await api.history(id);
      const commands: CommandDescriptor[] = await api.sessionCommands(id);
      this.update((s: HarnessState): void => {
        s.history = history;
        s.commands = commands;
      });
    });
  }

  async refreshSessionModels(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const models: SessionModels = await api.sessionModels(id);
      this.update((s: HarnessState): void => {
        s.sessionModels = models;
      });
    });
  }

  async selectModel(selection: ModelSelection): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      await api.selectModel(id, selection);
      const models: SessionModels = await api.sessionModels(id);
      this.update((s: HarnessState): void => {
        s.sessionModels = models;
      });
    });
  }

  async selectAgentPreset(agentPreset: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      await api.selectAgentPreset(id, agentPreset);
      const sessions: ChatSession[] = await api.sessions();
      const models: SessionModels = await api.sessionModels(id);
      const commands: CommandDescriptor[] = await api.sessionCommands(id);
      this.update((s: HarnessState): void => {
        s.sessions = sessions;
        s.sessionModels = models;
        s.commands = commands;
      });
    });
  }

  async refreshProviderSettings(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      if (!this.hasScope('settings.read')) {
        return;
      }
      const settings: ProviderSettings = await api.providerSettings();
      this.update((s: HarnessState): void => {
        s.providerSettings = settings;
      });
    });
  }

  async refreshPluginInventory(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      if (!this.hasScope('settings.read')) {
        return;
      }
      const inventory: PluginInventory = await api.pluginInventory();
      this.update((s: HarnessState): void => {
        s.pluginInventory = inventory;
      });
    });
  }

  /**
   * 带版本检查地刷新插件清单（用户主动点「检查更新」时）。
   *
   * 单独一条路而不是给 refreshPluginInventory 加参数：版本检查要给每个已装包发一次
   * registry 请求，清单会从毫秒级变成好几秒。默认那条必须保持轻快。
   */
  async refreshPluginInventoryWithUpdates(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      if (!this.hasScope('settings.read')) {
        return;
      }
      const inventory: PluginInventory = await api.pluginInventoryWithUpdates();
      this.update((s: HarnessState): void => {
        s.pluginInventory = inventory;
      });
    });
  }

  /**
   * 启用 / 停用一个插件。
   *
   * 走 launchOperation：全局 busy 把按钮禁掉，重复点击不会连发两次写请求（这是改
   * profile 的 package.json 的操作）；失败统一落进既有错误通道。
   * 成功后**必须重拉清单**，否则开关会弹回原位。
   */
  async setPluginLoaded(name: string, loaded: boolean): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      if (!this.hasScope('settings.write')) {
        this.notify(toastText('plugins_write_permission_required', this.lang()));
        return;
      }
      const result = await api.setPluginLoaded(name, loaded);
      const inventory: PluginInventory = await api.pluginInventory();
      this.update((s: HarnessState): void => {
        s.pluginInventory = inventory;
      });
      if (result.restartRequired) {
        this.notify(toastText('plugins_toggle_saved', this.lang()));
      }
    });
  }

  async updateProvider(providerId: string, patch: ProviderPatch): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const settings: ProviderSettings = await api.updateProvider(providerId, patch);
      this.update((s: HarnessState): void => {
        s.providerSettings = settings;
        s.discoveredModels = [];
      });
    });
  }

  async createCustomProvider(provider: CustomProviderCreate): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const settings: ProviderSettings = await api.createCustomProvider(provider);
      this.update((s: HarnessState): void => {
        s.providerSettings = settings;
        s.discoveredModels = [];
      });
    });
  }

  async discoverModels(providerId: string, baseURL: string | null, protocol: string | null,
                       apiKey: string | null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const models: ProviderModel[] = await api.discoverModels(providerId, baseURL, protocol, apiKey);
      this.update((s: HarnessState): void => {
        s.discoveredModels = models;
      });
    });
  }

  clearDiscoveredModels(): void {
    this.update((s: HarnessState): void => {
      s.discoveredModels = [];
    });
  }

  async cancelRun(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      await api.cancel(id);
      this.chatSessionRefreshPending = true;
      this.scheduleChatRefresh();
    });
  }

  async refreshPendingApprovals(): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    let approvals: PendingApproval[] | null = null;
    let failure: Object | null = null;
    try {
      approvals = await api.pendingApprovals(id);
    } catch (e) {
      failure = e as Object;
    }
    if (this.state.selectedSessionId !== id) {
      return;
    }
    if (approvals !== null) {
      this.update((s: HarnessState): void => {
        s.approvalState = approvals.length === 0
          ? ApprovalUiState.none() : ApprovalUiState.pending(approvals);
      });
    } else {
      this.update((s: HarnessState): void => {
        s.approvalState = ApprovalUiState.none();
        s.error = failure instanceof DshApiException && failure.code === 'RATE_LIMITED'
          ? null : this.messageOf(failure);
      });
    }
  }

  /**
   * 取当前会话的待回答问题。
   *
   * **只对当前选中的会话调**，一次一个 GET。插件的 `resolveAgent` 是「resolve **or
   * resume**」，对冷会话调会把那边已经停下的 Agent 拉活 —— 所以这里永远只看
   * `selectedSessionId`，绝不遍历 sessions，也不做任何后台轮询。
   *
   * 失败**刻意静默**：这条路会挂在全轮的 turn 事件上，插件版本旧（404）或一次网络抖都会
   * 失败；把错误塞进 snackbar 就等于每轮弹一次。列表也**保留原样**不清空。
   */
  async refreshPendingQuestions(): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    let sets: PendingQuestionSet[] | null = null;
    try {
      sets = await api.pendingQuestions(id);
    } catch (e) {
      sets = null;
    }
    // 期间用户可能已经切走：这份结果只对发起它的那个会话有效。
    if (this.state.selectedSessionId !== id) {
      return;
    }
    if (sets !== null) {
      const list: PendingQuestionSet[] = sets;
      const kept: PendingQuestionSet[] = [];
      for (let i = 0; i < list.length; i++) {
        // `state === continued`：内核已经继续跑了，答复属于**补交**而不是阻塞应答。
        // 其余状态（error/answered/…）再怎么答也没有意义，不该占着界面。
        if (list[i].isAnswerable()) {
          kept.push(list[i]);
        }
      }
      this.update((s: HarnessState): void => {
        s.questions = kept;
      });
    }
  }

  /**
   * 回答一组问题（`ask_user_question`）。
   *
   * 防重复提交两道闸：本地 `answeringCallId` 非空时直接忽略后续点击，已经答过的 callId
   * 也不再发；插件的 409 是最后一道防线，但不该让用户点到那一步。
   */
  async answerQuestions(callId: string, answers: QuestionAnswer[]): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    // 闸一：已有提交在飞。
    if (this.state.answeringCallId !== null) {
      return;
    }
    // 闸二：这一组已经答过。
    if (this.state.answeredCallIds.has(callId)) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.answeringCallId = callId;
      s.error = null;
    });
    let failure: Object | null = null;
    try {
      await api.answerQuestions(id, callId, answers);
    } catch (e) {
      failure = e as Object;
    }
    if (this.state.selectedSessionId !== id) {
      return;
    }
    if (failure === null) {
      this.update((s: HarnessState): void => {
        s.answeringCallId = null;
        const answered: Set<string> = new Set<string>();
        s.answeredCallIds.forEach((v: string): void => {
          answered.add(v);
        });
        answered.add(callId);
        s.answeredCallIds = answered;
      });
      // 问一次服务端：答复被内核吃掉了的话，这条问题就该从列表里消失。
      await this.refreshPendingQuestions();
    } else {
      const err: Object = failure;
      this.update((s: HarnessState): void => {
        s.answeringCallId = null;
        s.error = this.describeAnswerFailure(err);
      });
    }
  }

  /**
   * 提交失败的人话。
   *
   * 插件用 409 区分两种**完全不同**的情况：答复已经在队列里（你答过了）与问题已经不作答
   * （这条作废了）。把 code 原样甩给用户，他既看不懂也不知道该不该重试。
   */
  private describeAnswerFailure(failure: Object): string {
    if (failure instanceof DshApiException && failure.code === 'QUESTION_REPLY_QUEUED') {
      return toastText('answer_already_queued', this.lang());
    }
    if (failure instanceof DshApiException && failure.code === 'QUESTION_NOT_PENDING') {
      return toastText('answer_not_pending', this.lang());
    }
    if (failure instanceof DshApiException && (failure.status === 403
      || failure.code.indexOf('FORBIDDEN') >= 0 || failure.code.indexOf('SCOPE') >= 0)) {
      return toastText('answer_no_write', this.lang());
    }
    return toastText('answer_failed', this.lang(), this.messageOf(failure));
  }

  async decideApproval(approval: PendingApproval, allowOnce: boolean): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    if (approval.sessionId !== id) {
      return;
    }
    const current: ApprovalUiState = this.state.approvalState;
    let items: PendingApproval[];
    if (current.kind === ApprovalUiKind.PENDING || current.kind === ApprovalUiKind.DECIDING) {
      items = current.items;
    } else {
      items = [approval];
    }
    this.update((s: HarnessState): void => {
      s.approvalState = ApprovalUiState.deciding(approval, items);
      s.error = null;
    });
    let approvals: PendingApproval[] | null = null;
    let sessions: ChatSession[] | null = null;
    let failure: Object | null = null;
    try {
      await api.decideApproval(id, approval.id, allowOnce);
      approvals = await api.pendingApprovals(id);
      sessions = await api.sessions();
    } catch (e) {
      failure = e as Object;
    }
    if (this.state.selectedSessionId === id) {
      if (approvals !== null && sessions !== null) {
        const nextApprovals: PendingApproval[] = approvals;
        const nextSessions: ChatSession[] = sessions;
        this.update((s: HarnessState): void => {
          s.approvalState = nextApprovals.length === 0
            ? ApprovalUiState.none() : ApprovalUiState.pending(nextApprovals);
          s.sessions = nextSessions;
        });
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
      } else {
        const err: Object = failure;
        this.update((s: HarnessState): void => {
          s.approvalState = ApprovalUiState.pending(items);
          s.error = this.messageOf(err);
        });
      }
    }
  }

  // ————————————————— 文件浏览与编辑 —————————————————

  async selectRoot(id: string): Promise<void> {
    this.update((s: HarnessState): void => {
      s.selectedRootId = id;
      s.currentPath = '';
      s.document = null;
    });
    await this.loadDirectory('');
  }

  async loadDirectory(path: string | null = null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const target: string = path !== null ? path : this.state.currentPath;
      const normalized: string = trimChar(target, '/');
      const page: DirectoryPage = await api.entries(root, normalized);
      this.update((s: HarnessState): void => {
        s.currentPath = normalized;
        s.directory = page;
        s.document = null;
      });
    });
  }

  async loadNextDirectoryPage(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const current: DirectoryPage | null = this.state.directory;
      if (current === null) {
        return;
      }
      const cursor: string | null = current.nextCursor;
      if (cursor === null) {
        return;
      }
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const next: DirectoryPage = await api.entries(root, current.path, cursor);
      this.update((s: HarnessState): void => {
        const seen: Set<string> = new Set<string>();
        const merged: FileEntry[] = [];
        const all: FileEntry[] = current.entries.concat(next.entries);
        for (let i = 0; i < all.length; i++) {
          const e: FileEntry = all[i];
          if (!seen.has(e.path)) {
            seen.add(e.path);
            merged.push(e);
          }
        }
        s.directory = current.withMerged(merged, next.nextCursor);
      });
    });
  }

  /**
   * 加载当前会话**工作目录**的条目，供输入框 `@` 补全。
   *
   * **只用两步，不走 `resolvePath`**：会话里已经有 `rootId`，而 `cwd` 本身就是「相对授权根」
   * 的 wire 路径 —— 列举接口要的正是这两样。
   *
   * **`cwd` 为空字符串是合法值**，表示会话工作目录就是授权根本身。此前把它当成「没有工作
   * 目录」丢掉 —— 线上那句「读不到这个会话的工作目录」就是这么来的。
   *
   * 拿不到时把 `mentionFailed` 置真，让界面如实说「读不到」，而不是谎称「目录是空的」。
   */
  async loadMentionEntries(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const sessionId: string | null = this.state.selectedSessionId;
      if (sessionId === null) {
        return;
      }
      let session: ChatSession | null = null;
      for (let i = 0; i < this.state.sessions.length; i++) {
        if (this.state.sessions[i].id === sessionId) {
          session = this.state.sessions[i];
          break;
        }
      }
      if (session === null) {
        return;
      }
      let page: DirectoryPage | null = null;
      try {
        // 空 cwd（= 授权根本身）照常列举；trim('/') 只把结尾多余的斜杠收干净。
        page = await api.entries(session.rootId, trimChar(session.cwd, '/'));
      } catch (e) {
        page = null;
      }
      // 会话可能在请求期间被切走，回来发现已是另一个会话就别把那批文件塞进去。
      if (this.state.selectedSessionId !== sessionId) {
        return;
      }
      const got: DirectoryPage | null = page;
      this.update((s: HarnessState): void => {
        if (got === null) {
          s.mentionEntries = null;
          s.mentionFailed = true;
        } else {
          s.mentionEntries = got.entries;
          s.mentionFailed = false;
        }
      });
    });
  }

  /**
   * 把「输入框上方的补全面板开着」这个事实同步出去，供外层抽屉决定是否响应滑动手势。
   *
   * 只在**值真的变了**的时候写 state —— 这个函数会在重组路径上被调到，每次无条件 update
   * 会白白推一串快照。
   */
  setComposerOverlay(active: boolean): void {
    if (this.state.composerOverlay === active) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.composerOverlay = active;
    });
  }

  async openEntry(entry: FileEntry): Promise<void> {
    if (entry.kind === 'directory') {
      await this.loadDirectory(entry.path);
      return;
    }
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      // 图片与 PDF 有自己的字节上限：文本的 2 MiB 闸对它们太紧，但也不能不设闸。
      const provisional: PreviewKind = previewKind(entry.name, null);
      const capRaw: number | null = binaryPreviewByteLimit(provisional);
      const cap: number = capRaw !== null ? capRaw : MAX_EDIT_BYTES;
      if (entry.size > cap) {
        this.update((s: HarnessState): void => {
          s.document = new OpenDocument(entry, null, '', false, '\n', null, null, true);
          // 文本超限沿用既有的全局提示；图片 / PDF 的提示由预览面板自己给（带「下载」出路）。
          s.error = provisional === PreviewKind.IMAGE || provisional === PreviewKind.PDF
            ? null : FILE_TOO_LARGE;
        });
        return;
      }
      const content: FileContent = await api.readFile(root, entry.path);
      // 拿到字节后重判一次：FileEntry 里没有 contentType，服务端 MIME 也不可靠，
      // 所以「没有扩展名 / 扩展名是 .bin 的图片」只能靠魔数认出来。
      const kind: PreviewKind = previewKindOf(entry.name, content.contentType, content.bytes);
      if (kind === PreviewKind.IMAGE || kind === PreviewKind.PDF) {
        this.update((s: HarnessState): void => {
          s.document = new OpenDocument(entry, null, content.etag, false, '\n',
            content.contentType, content.bytes, false);
          s.error = null;
        });
        return;
      }
      const decoded: DecodedText | null = decodeUtf8(content.bytes);
      this.update((s: HarnessState): void => {
        s.document = new OpenDocument(entry, decoded !== null ? decoded.text : null, content.etag,
          decoded !== null ? decoded.hasBom : false, decoded !== null ? decoded.lineEnding : '\n',
          content.contentType, null, false);
        s.error = decoded === null ? BINARY_FILE : null;
      });
    });
  }

  selectEntryForAction(entry: FileEntry): void {
    this.update((s: HarnessState): void => {
      s.document = new OpenDocument(entry);
    });
  }

  updateDocument(text: string): void {
    this.update((s: HarnessState): void => {
      s.document = s.document === null ? null : s.document.withText(text);
    });
  }

  async saveDocument(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const document: OpenDocument | null = this.state.document;
      if (document === null) {
        return;
      }
      const text: string | null = document.text;
      if (text === null) {
        return;
      }
      const normalized: string = text.split('\r\n').join('\n').split('\r').join('\n');
      let encoded: string = normalized;
      if (document.lineEnding === '\r\n') {
        encoded = normalized.split('\n').join('\r\n');
      } else if (document.lineEnding === '\r') {
        encoded = normalized.split('\n').join('\r');
      }
      const body: Uint8Array = utf8Encode(encoded);
      const bytes: Uint8Array = document.hasBom ? concatBytes(UTF8_BOM, body) : body;
      const etag: string = await api.writeFile(root, document.entry.path, bytes, document.etag);
      this.update((s: HarnessState): void => {
        s.document = s.document === null ? null : s.document.withEtag(etag);
      });
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      this.update((s: HarnessState): void => {
        s.directory = page;
      });
    });
  }

  async createEntry(name: string, directory: boolean): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      await api.createEntry(root, childPath(this.state.currentPath, name), directory);
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      this.update((s: HarnessState): void => {
        s.directory = page;
      });
    });
  }

  async moveSelected(destination: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const document: OpenDocument | null = this.state.document;
      if (document === null) {
        return;
      }
      await api.moveEntry(root, document.entry.path, trimChar(destination, '/'));
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      this.update((s: HarnessState): void => {
        s.document = null;
        s.directory = page;
      });
    });
  }

  async trashSelected(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const document: OpenDocument | null = this.state.document;
      if (document === null) {
        return;
      }
      await api.trashEntry(root, document.entry.path);
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      const trash: TrashEntry[] = await api.trash();
      this.update((s: HarnessState): void => {
        s.document = null;
        s.directory = page;
        s.trash = trash;
      });
    });
  }

  /** 上传一个新文件到当前目录（平台层已读好字节）。 */
  async upload(name: string, bytes: Uint8Array): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      await api.writeFile(root, childPath(this.state.currentPath, name), bytes, null);
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      this.update((s: HarnessState): void => {
        s.directory = page;
      });
    });
  }

  /** 用一段新字节替换当前选中的文件（etag 为空时先读一次拿权威值）。 */
  async replaceSelected(bytes: Uint8Array): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const document: OpenDocument | null = this.state.document;
      if (document === null) {
        return;
      }
      let etag: string = document.etag;
      if (isBlank(etag)) {
        const content: FileContent = await api.readFile(root, document.entry.path);
        etag = content.etag;
      }
      await api.writeFile(root, document.entry.path, bytes, etag);
      await this.openEntry(document.entry.withSize(bytes.length));
    });
  }

  /** 下载当前选中的文件：平台层用返回的字节写盘。 */
  async downloadSelected(): Promise<Uint8Array> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return new Uint8Array(0);
    }
    const root: string | null = this.state.selectedRootId;
    if (root === null) {
      return new Uint8Array(0);
    }
    const document: OpenDocument | null = this.state.document;
    if (document === null) {
      return new Uint8Array(0);
    }
    const content: FileContent = await api.readFile(root, document.entry.path);
    return content.bytes;
  }

  async loadTrash(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const trash: TrashEntry[] = await api.trash();
      this.update((s: HarnessState): void => {
        s.trash = trash;
      });
    });
  }

  async restoreTrash(id: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.restoreTrash(id);
      const trash: TrashEntry[] = await api.trash();
      this.update((s: HarnessState): void => {
        s.trash = trash;
      });
      await this.loadDirectory(null);
    });
  }

  // ————————————————— 启动恢复 / 事件流 —————————————————

  /**
   * 启动时恢复连接：读取已保存的主机（必要时先迁移旧版数据），再自动尝试最近用过的那台。
   *
   * 与旧实现的一个关键差别：旧版在恢复失败时执行 `store.clear()`，把令牌一并删掉。
   * 那意味着「此刻网络不通」会被误判成「凭据失效」—— 用户回到家才发现要重新配对。
   * 现在连不上只保留未连接状态，主机记录不动。
   */
  async restoreConnection(): Promise<void> {
    const hosts: Host[] = await this.loadOrMigrateHosts();
    if (hosts.length === 0) {
      this.update((s: HarnessState): void => {
        s.restoring = false;
      });
      return;
    }
    // updatedAt 会在每次探活后刷新，所以「最近活动过」近似等于「上次用过的」。
    let target: Host = hosts[0];
    for (let i = 1; i < hosts.length; i++) {
      if (hosts[i].updatedAt > target.updatedAt) {
        target = hosts[i];
      }
    }
    const chosen: Host = target;
    this.update((s: HarnessState): void => {
      s.hosts = hosts;
      s.selectedHostId = chosen.id;
      s.endpointDraft = chosen.endpoints.length > 0 ? chosen.endpoints[0].baseUrl : '';
      s.restoring = true;
    });
    try {
      await this.connectHostInternal(chosen);
    } catch (e) {
      const failure: Object = e as Object;
      this.update((s: HarnessState): void => {
        s.restoring = false;
        s.connecting = false;
        s.error = this.messageOf(failure);
      });
    }
  }

  /** 读取主机列表；为空时尝试把旧版单连接数据迁进来。迁移是幂等的。 */
  private async loadOrMigrateHosts(): Promise<Host[]> {
    const existing: Host[] = this.deps.hostStore.loadHosts();
    if (existing.length > 0) {
      return existing;
    }
    try {
      LegacyConnectionMigration.migrate(this.deps.legacyKeyValueStore, this.deps.legacySecretBox,
        this.deps.hostStore);
      return this.deps.hostStore.loadHosts();
    } catch (e) {
      return [];
    }
  }

  /**
   * 熄屏暂停事件流；亮屏恢复（用户定下的策略：**熄屏=断连，亮屏=实时**）。
   *
   * 为什么不是断开连接：`disconnect()` 会把 `active` 一起清掉，亮屏后得重新走一遍探活 +
   * 配对校验。熄屏时真正费电的只有那条 WebSocket，所以只关流、**保留已建立的连接与令牌**。
   */
  pauseEvents(): void {
    if (this.eventSubscription === null) {
      return;
    }
    this.eventsPaused = true;
    this.eventSubscription.close();
    this.eventSubscription = null;
    // 状态里保留 connected = true：连接本身（主机、令牌、端点）都还在，只是事件流暂停。
  }

  async resumeEvents(): Promise<void> {
    if (!this.eventsPaused) {
      return;
    }
    this.eventsPaused = false;
    const connection: ActiveConnection | null = this.active;
    if (connection === null) {
      return;
    }
    this.connectEvents(connection.client);
    // 补上熄屏期间错过的一切：当前会话的历史 + 会话列表。
    this.chatSessionRefreshPending = true;
    this.scheduleChatRefresh();
    // 还要单独补两类**交互性**状态：审批面板与待答问题。
    await this.refreshPendingApprovals();
    await this.refreshPendingQuestions();
  }

  private connectEvents(api: DshClient): void {
    if (this.eventSubscription !== null) {
      this.eventSubscription.close();
      this.eventSubscription = null;
    }
    const self: HarnessViewModel = this;
    this.eventSubscription = api.events(
      (event: WorkspaceEvent): void => {
        self.handleEvent(event);
      },
      (connected: boolean): void => {
        self.handleConnection(connected);
      },
    );
  }

  private handleConnection(connected: boolean): void {
    this.update((s: HarnessState): void => {
      s.eventsConnected = connected;
    });
    if (connected && this.state.selectedSessionId !== null) {
      this.scheduleChatRefresh();
      void this.refreshPendingApprovals();
      // 断线期间问出来的问题要靠这一下补回来。
      void this.refreshPendingQuestions();
      void this.refreshCommands();
    }
  }

  private handleEvent(event: WorkspaceEvent): void {
    const delta: ChatDelta | null = chatDelta(event);
    if (delta !== null) {
      const d: ChatDelta = delta;
      if (this.state.selectedSessionId === d.sessionId) {
        this.update((s: HarnessState): void => {
          const base: LiveChatState = s.liveChat !== null
            ? s.liveChat : new LiveChatState(d.sessionId, d.turn, d.step);
          s.liveChat = base.append(d);
        });
        // 正文一律走历史那条路（页面只从历史渲染），所以每来一段增量都要让历史跟上，
        // 否则流式文字要等消息落盘才出现。scheduleChatRefresh 自带 400ms 去抖 + 单飞。
        this.scheduleChatRefresh();
      }
    } else if (event.type.startsWith('chat.')) {
      const sessionId: string | null = eventDataString(event, 'sessionId');
      if (event.type === 'chat.message.committed') {
        if (sessionId !== null && sessionId === this.state.selectedSessionId) {
          if (eventDataString(event, 'role') === 'assistant') {
            const turn: number | null = eventDataInt(event, 'turn');
            const step: number | null = eventDataInt(event, 'step');
            if (turn !== null && step !== null) {
              this.liveFinalizeTarget = new LiveKey(sessionId, turn, step);
            }
          }
          this.scheduleChatRefresh();
        }
      } else if (event.type === 'chat.turn.start' || event.type === 'chat.turn.end'
        || event.type === 'chat.session.status') {
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
        // 「这一轮刚结束」= 会话已不在运行。这是工具结果帧那条路的兜底：在轮次结束的
        // **那一刻**补拉一次，之后彻底停止 —— 不是轮询。
        if (event.type === 'chat.turn.end' && sessionId !== null && !this.isSessionRunning(sessionId)) {
          void this.refreshPendingQuestions();
        }
      } else if (event.type === 'chat.agent-preset.selected') {
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
        if (sessionId === this.state.selectedSessionId) {
          void this.refreshSessionModels();
        }
      } else if (event.type === 'chat.turn.failed') {
        this.handleTurnFailed(event, sessionId);
      } else if (event.type === 'chat.approval.requested' || event.type === 'chat.approval.resolved') {
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
        if (sessionId === this.state.selectedSessionId) {
          void this.refreshPendingApprovals();
        }
      } else if (sessionId === this.state.selectedSessionId) {
        this.scheduleChatRefresh();
      }

      // 待答问题的刷新靠事件驱动，**不引定时器、不轮询**：一条相关事件一次 GET。
      // `chat.session.event` 是插件给所有「非特殊」会话事件的统一降级形态，
      // `tool/result` 走的正是它。这里按 eventType 精确挑出工具结果，不做「来一帧就拉一次」。
      if (QUESTION_REFRESH_EVENTS.has(event.type) || isToolResultFrame(event.type, event.data)) {
        void this.refreshPendingQuestions();
      }
      // 插件为问答推的**专属帧**：提问一落地就能拿到通知；答完之后卡片也能**立刻**消失。
      if (event.type === 'chat.userQuestions/requested') {
        void this.refreshPendingQuestions();
      } else if (event.type === 'chat.userQuestions/answered' || event.type === 'chat.userQuestions/dismissed') {
        // 这两帧是「这道题已经不用答了」的确定性事实 —— 直接摘掉，不必等一次网络往返。
        const callId: string | null = eventDataString(event, 'callId');
        if (callId !== null) {
          this.update((s: HarnessState): void => {
            s.questions = removeQuestion(s.questions, callId);
          });
        }
      }
    }
    if (event.type.startsWith('file.')) {
      void this.loadDirectory(null);
    }
  }

  /**
   * 终局失败帧（限流 429、配额用尽、密钥无效、登出停止）的就地处理。
   *
   * 为什么必须在这里就地处理、而不是等 `chat.turn.end`：插件为失败发的**就是**这一帧，
   * `chat.turn.end` 那一帧在失败时不再发。做三件事：
   * 1) 立即把会话标记为不在运行（本地置位，不等下一次 GET）；
   * 2) 走全局错误通道让用户看见那句话；
   * 3) 拉一次历史与待答问题。
   */
  private handleTurnFailed(event: WorkspaceEvent, sessionId: string | null): void {
    const failure: ChatTurnFailure | null = chatTurnFailure(event);
    if (failure === null) {
      return;
    }
    const f: ChatTurnFailure = failure;
    if (sessionId !== null) {
      const sid: string = sessionId;
      this.update((s: HarnessState): void => {
        s.sessions = markSessionStopped(s.sessions, sid);
        if (s.selectedSessionId === sid) {
          s.liveChat = null;
          s.busySendMode = SEND_MODE_QUEUE;
        }
      });
    }
    if (sessionId === this.state.selectedSessionId) {
      // 流式缓冲清掉：失败之后留着半截文字，用户会以为「它还在说，只是慢」。
      // 出错文案跟随界面语言：先按错误码本地化，命不中才用内核原文。
      const localized: string | null = localizedErrorText(f.code, this.lang());
      let message: string;
      if (localized === null) {
        message = f.message.length > 0 ? f.message : toastText(f.titleKey, this.lang());
      } else {
        message = localized;
      }
      this.notify(message);
      // 挂起的提问卡片也要撤：这一轮已经结束了，卡片继续挂着会让人以为问题还有效。
      void this.refreshPendingQuestions();
    }
    this.chatSessionRefreshPending = true;
    this.scheduleChatRefresh();
  }

  private async loadSnapshot(api: DshClient, device: DeviceView): Promise<HarnessState> {
    const canReadFiles: boolean = device.scopes.indexOf('files.read') >= 0;
    const canReadChat: boolean = device.scopes.indexOf('chat.read') >= 0;
    const canReadSettings: boolean = device.scopes.indexOf('settings.read') >= 0;
    // 这些快照请求**互不依赖**，全部并行发出 —— 原版串行 await（最多 7 个请求排队）在局域网
    // 上也要累加每个请求的往返，用户体感就是连接页的「正在探测…」挂好几秒（真机反馈：
    // 「局域网应该 1 秒左右就好」）。写法上先启动全部 Promise、再逐个 await：已完成的
    // promise await 起来是零开销，错误也仍从对应的那一个 await 点抛出（与串行版一致）。
    // 唯一的依赖链是 `entries()` 要等 `roots()` 给出第一个根目录，所以单独放第二波。
    const rootsP: Promise<RootView[]> = canReadFiles ? api.roots() : Promise.resolve<RootView[]>([]);
    const sessionsP: Promise<ChatSession[]> = canReadChat ? api.sessions() : Promise.resolve<ChatSession[]>([]);
    const workspacesP: Promise<ChatWorkspace[]> = canReadChat
      ? api.chatWorkspaces() : Promise.resolve<ChatWorkspace[]>([]);
    const presetsP: Promise<AgentPreset[]> = canReadChat
      ? api.agentPresets() : Promise.resolve<AgentPreset[]>([]);
    const settingsP: Promise<ProviderSettings | null> = canReadSettings
      ? api.providerSettings() : Promise.resolve<ProviderSettings | null>(null);
    const pluginsP: Promise<PluginInventory | null> = canReadSettings
      ? api.pluginInventory() : Promise.resolve<PluginInventory | null>(null);
    const trashP: Promise<TrashEntry[]> = canReadFiles ? api.trash() : Promise.resolve<TrashEntry[]>([]);

    const roots: RootView[] = await rootsP;
    const selectedRoot: string | null = roots.length > 0 ? roots[0].id : null;
    const directoryP: Promise<DirectoryPage | null> = selectedRoot !== null
      ? api.entries(selectedRoot) : Promise.resolve<DirectoryPage | null>(null);

    const sessions: ChatSession[] = await sessionsP;
    const chatWorkspaces: ChatWorkspace[] = await workspacesP;
    const agentPresets: AgentPreset[] = await presetsP;
    const providerSettings: ProviderSettings | null = await settingsP;
    const pluginInventory: PluginInventory | null = await pluginsP;
    const trash: TrashEntry[] = await trashP;
    const directory: DirectoryPage | null = await directoryP;
    const st: HarnessState = new HarnessState();
    st.restoring = false;
    st.connected = true;
    st.endpoint = api.endpoint;
    st.endpointDraft = stripApiSuffix(api.endpoint);
    st.healthOk = true;
    st.device = device;
    st.roots = roots;
    st.sessions = sessions;
    st.chatWorkspaces = chatWorkspaces;
    st.agentPresets = agentPresets;
    st.providerSettings = providerSettings;
    st.pluginInventory = pluginInventory;
    st.selectedRootId = selectedRoot;
    st.directory = directory;
    st.trash = trash;
    // 快照是整份重建的，偏好字段必须重新盖回去。
    this.applyPreferences(st);
    return st;
  }

  /**
   * 400ms **去抖**，不是轮询周期。
   *
   * 旧实现是 `delay(1_000)` 之后回 while 条件，而**每一个事件帧都会把 chatRefreshPending
   * 重新置 true**。于是模型流式输出期间，这一秒内只要来过任何一帧，循环就继续转 —— 实际
   * 表现是**整个流式期间每秒拉一次全量 history**。用户侧的体感就是「一用 APP 电量掉得快」。
   *
   * 现在改成：等到**安静 400ms** 才拉一次，且一轮只拉一次。流式输出期间事件不断到来，
   * 窗口一直被重置、任务一直不起跑；等这一轮消息落定、事件安静下来，才做那唯一一次
   * history()。400ms 是取舍：短于它会漏掉「最后一条消息落盘」的信号，长于它用户会看到
   * 正文延迟。liveChat 的 delta 推送不受这个窗口影响。
   */
  private scheduleChatRefresh(): void {
    this.chatRefreshPending = true;
    if (this.chatRefreshActive) {
      return;
    }
    this.chatRefreshActive = true;
    const self: HarnessViewModel = this;
    // 句柄必须记下来：`dispose()` 要把它（以及下面 `sleep` 里的那一批）一次性取消，
    // 否则页面销毁后这个定时器还会醒过来、去访问已经作废的连接。Kotlin 侧靠
    // `viewModelScope` 自动取消，这里得自己管。
    const handle: number = this.deps.timers.schedule(400, (): void => {
      void self.runChatRefresh();
    });
    this.timerHandles.push(handle);
  }

  private async runChatRefresh(): Promise<void> {
    try {
      await this.chatRefreshLoop();
    } finally {
      this.chatRefreshActive = false;
    }
  }

  private async chatRefreshLoop(): Promise<void> {
    while (this.chatRefreshPending || this.chatSessionRefreshPending) {
      this.chatRefreshPending = false;
      const refreshSessions: boolean = this.chatSessionRefreshPending;
      this.chatSessionRefreshPending = false;
      const finalizeTarget: LiveKey | null = this.liveFinalizeTarget;
      this.liveFinalizeTarget = null;
      const api: DshClient | null = this.client();
      if (api === null) {
        break;
      }
      const id: string | null = this.state.selectedSessionId;
      if (id !== null) {
        let history: ChatHistory | null = null;
        try {
          history = await api.history(id);
        } catch (error) {
          if (!(error instanceof DshApiException && error.code === 'RATE_LIMITED')) {
            const err: Object = error as Object;
            this.update((s: HarnessState): void => {
              s.error = this.messageOf(err);
            });
          } else {
            if (finalizeTarget !== null) {
              this.liveFinalizeTarget = finalizeTarget;
            }
            this.chatRefreshPending = true;
          }
        }
        if (history !== null) {
          const got: ChatHistory = history;
          if (this.state.selectedSessionId === id) {
            this.update((s: HarnessState): void => {
              let clearLive: boolean = false;
              if (finalizeTarget !== null && s.liveChat !== null) {
                clearLive = s.liveChat.sessionId === finalizeTarget.sessionId
                  && s.liveChat.turn === finalizeTarget.turn
                  && s.liveChat.step === finalizeTarget.step;
              }
              s.history = got;
              if (clearLive) {
                s.liveChat = null;
              }
            });
          }
        }
      }
      if (refreshSessions) {
        let sessions: ChatSession[] | null = null;
        try {
          sessions = await api.sessions();
        } catch (error) {
          if (error instanceof DshApiException && error.code === 'RATE_LIMITED') {
            this.chatSessionRefreshPending = true;
          } else {
            const err: Object = error as Object;
            this.update((s: HarnessState): void => {
              s.error = this.messageOf(err);
            });
          }
        }
        if (sessions !== null) {
          const got: ChatSession[] = sessions;
          this.update((s: HarnessState): void => {
            s.sessions = got;
          });
        }
      }
      // 限流重试之外的正常路径到这里就该收工了。保留一个短的「再确认一次」窗口：
      // 处理 history 的这段时间里可能又来了新帧。
      await this.sleep(400);
      if (!this.chatRefreshPending && !this.chatSessionRefreshPending) {
        break;
      }
    }
  }

  /** 用注入的定时器睡一觉（对应 Kotlin `delay(ms)`）。 */
  private sleep(ms: number): Promise<void> {
    const self: HarnessViewModel = this;
    return new Promise<void>((resolve: () => void): void => {
      let handle: number = -1;
      handle = self.deps.timers.schedule(ms, (): void => {
        const at: number = self.timerHandles.indexOf(handle);
        if (at >= 0) {
          self.timerHandles.splice(at, 1);
        }
        resolve();
      });
      self.timerHandles.push(handle);
    });
  }

  private async withClient(block: (api: DshClient) => Promise<void>): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    await this.launchOperation(async (): Promise<void> => {
      await block(api);
    });
  }

  private async launchOperation(block: () => Promise<void>): Promise<void> {
    this.update((s: HarnessState): void => {
      s.busy = true;
      s.error = null;
    });
    try {
      await block();
    } catch (e) {
      const failure: Object = e as Object;
      this.update((s: HarnessState): void => {
        s.error = this.messageOf(failure);
      });
    }
    this.update((s: HarnessState): void => {
      s.busy = false;
    });
  }

  /** 替代 Kotlin 的 `onCleared()`：取消定时器、关闭事件订阅、关闭协调层。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (let i = 0; i < this.timerHandles.length; i++) {
      this.deps.timers.cancel(this.timerHandles[i]);
    }
    this.timerHandles = [];
    this.chatRefreshActive = false;
    if (this.eventSubscription !== null) {
      this.eventSubscription.close();
      this.eventSubscription = null;
    }
    // 协调层自带在途探活，不显式关闭的话，探活期间挂死的调用会一直占着资源。
    this.deps.coordinator.close();
    this.listeners = [];
  }

  /**
   * 异常 → 给人看的句子。分三层：
   *
   * 1. `DshApiException`（服务端错误码）→ 按码查本地化表；认不出**保留原文**。
   * 2. `DshConnectionException` → 「全部地址不可达」的本地化句（携带全部探活原因）。
   * 3. `NetworkException`（平台层把错误码翻译成 `NetworkFailureKind` 再抛）→ 按类型本地化。
   *    安卓那 7 个 `IOException` 分支（超时/未知主机/连接被拒/SSL/Socket/EOF/其他）在这里
   *    **有意收敛成一条** —— 平台层已把病因归好类，core 不必认识那些平台异常类。
   * 4. 其余未知异常 → 保留原文，能搜能贴给开发者（与错误码表「认不出不硬猜」同一原则）。
   */
  private messageOf(error: Object): string {
    if (error instanceof DshApiException) {
      const text: string | null = localizedErrorText(error.code, this.lang());
      return text === null ? error.message : text;
    }
    if (error instanceof DshConnectionException) {
      return allEndpointsUnreachableText(this.lang());
    }
    if (error instanceof NetworkException) {
      return networkErrorText(error.kind, this.lang(), error.detail);
    }
    if (error instanceof Error) {
      if (error.message.length > 0) {
        return error.message;
      }
      return error.name.length > 0 ? error.name : 'Error';
    }
    return 'unknown failure';
  }
}
