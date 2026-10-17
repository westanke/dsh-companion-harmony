/**
 * 界面主状态机 —— **状态与类型**（从 `HarnessViewModel.ts` 拆出）。
 *
 * 装的是界面要消费的全部数据形状：内存闸常量（`MAX_EDIT_BYTES` / `PREVIEW_CHARS`）、
 * 会话文件与文档（`OpenDocument` / `SessionFileOpen` / `PendingAttachment`）、
 * 审批与问答的界面态（`ApprovalUiKind` / `ApprovalUiState`）、以及**整份界面状态**
 * `HarnessState`。
 *
 * `HarnessState` 是普通 class、字段默认值与 Kotlin 的 `data class` 逐字对应，
 * 且**就地改、不重建**（见 `HarnessViewModelBase` 的 `update`）。这两个性质是
 * `@Prop` 之外唯一能让 ArkUI 稳定拿到最新值的方式，改动前务必先读 `HarnessViewModel.ts` 文件头。
 *
 * 拆分来龙去脉见 `HarnessViewModel.ts`。
 */

import {
  AgentPreset,
  ChatHistory,
  ChatSession,
  ChatWorkspace,
  CommandDescriptor,
  DeviceView,
  DirectoryPage,
  FileEntry,
  PendingApproval,
  PendingQuestionSet,
  PluginInventory,
  PromptPart,
  ProviderModel,
  ProviderSettings,
  ResolvedPath,
  RootView,
  SessionModels,
  TrashEntry,
} from './Models';
import {
  EndpointProbe,
  Host,
} from './ConnectionModels';
import {
  LiveChatState,
} from './ChatPresentation';
import {
  SEND_MODE_QUEUE,
} from './ComposerSendPolicy';
import {
  FONT_SCALE_DEFAULT,
} from './FontScale';
import {
  THEME_MODE_SYSTEM,
} from './ThemeMode';

/** 文本编辑的内存闸：与 Kotlin `MAX_EDIT_BYTES` 一致（2 MiB）。 */
export const MAX_EDIT_BYTES: number = 2 * 1024 * 1024;
/** 面板只读预览的字符上限（整个文件仍按 2 MiB 上限读进 document 供编辑器用）。 */
export const PREVIEW_CHARS: number = 20000;

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
  /** 服务端在 `connection.ready` 自报的插件版本（仅诊断展示，不作功能判据）；null = 还没读到。 */
  bridgeVersion: string | null = null;
  /**
   * 服务端自报的能力位；**null = 未知**（旧服务端不报、或清单为空）。
   *
   * 未知与「空清单」刻意分开：把未知当成「什么都缺」会弹出假警告，
   * 而假警告比没有警告更坏（详见 `core/BridgeCapabilities.ts`）。
   */
  bridgeCapabilities: Set<string> | null = null;
  /**
   * 事件流里**已经并进来的最大序号**；null = 还没有起点。
   *
   * 用途只有一个：发现「历史与事件流之间有洞」时触发一次 resync（见
   * `core/ChatSeqMonitor.ts`）。它不参与任何渲染判据 —— 所以既不必进 `copyFrom`，
   * 也不必被快照重建覆盖（重建时会被清零，而清零等于「重新找一个起点」，语义正确）。
   */
  lastEventSeq: number | null = null;
  /**
   * 订阅时服务端给的**游标**（`chat.session.snapshot.cursor`）；null = 服务端没给。
   *
   * 它是「REST 拉历史」与「WS 订阅」之间那个时间洞的参照点：本地历史落后于它，
   * 就说明中间那段谁都没管，必须重取一次。
   */
  baselineCursor: number | null = null;
  roots: RootView[] = [];
  sessions: ChatSession[] = [];
  /**
   * **已归档**会话（对位源工程 `HarnessState.archivedSessions`）。
   *
   * 与 `sessions` 分开存、不在本地合并过滤：归档视图是**独立入口**（不是过滤器），
   * 而且这个列表只在服务端声明了 `session-archive-list-v1` 能力位时才会被填充 ——
   * 老 bridge 会忽略 `archived` 参数返回未归档列表，合并展示会得到「一条归档都没有」的假结论。
   */
  archivedSessions: ChatSession[] = [];
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
   * 应用内字号倍数（0.8–1.5，步进 0.1）。
   *
   * 与 `composerText`（输入框原文）**刻意分开**：这一个不是输入框，而是滑块 ——
   * 滑块的拖动过程中每一帧都会被写成新值，若与输入框共用字段，
   * 拖动一次就会把用户没发出去的草稿洗掉。
   */
  fontScale: number = FONT_SCALE_DEFAULT;
  /** 字号是否跟随系统（true 时应用这层不做任何缩放）。默认 true，见 `AppPreferences`。 */
  fontFollowsSystem: boolean = true;
  /** 主题档位：`system` / `light` / `dark`，默认跟随系统。 */
  themeMode: string = THEME_MODE_SYSTEM;
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
    this.bridgeVersion = other.bridgeVersion;
    this.bridgeCapabilities = other.bridgeCapabilities;
    this.roots = other.roots;
    this.sessions = other.sessions;
    this.archivedSessions = other.archivedSessions;
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
    this.fontScale = other.fontScale;
    this.fontFollowsSystem = other.fontFollowsSystem;
    this.themeMode = other.themeMode;
    this.pendingText = other.pendingText;
    this.attachmentImages = other.attachmentImages;
    this.attachmentFailures = other.attachmentFailures;
    this.pendingAttachments = other.pendingAttachments;
    this.attachmentUploading = other.attachmentUploading;
    this.error = other.error;
  }
}
