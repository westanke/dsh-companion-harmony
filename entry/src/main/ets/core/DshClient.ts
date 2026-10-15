/**
 * DSH 服务端客户端 —— 移植自原工程 `data/DshClient.kt`（653 行）。
 *
 * 分层原则（本文件最重要的设计决定）：**逻辑层不碰任何平台 API**。
 * 原工程直接用 OkHttp + OkHttp WebSocket；鸿蒙侧对应 `@ohos.net.http` / `@ohos.net.webSocket`，
 * 但把那些 API 焊进业务逻辑里，就没法离线单测，也没法在 node 下跑契约测试。
 * 所以这里抽出两个注入点：
 * - `HttpTransport`：一次请求 → 一次响应（含超时元数据）；
 * - `WebSocketTransport` + `TimerBridge`：长连接与「延迟重连」的定时能力。
 * 逻辑层只负责：URL 拼装、鉴权头注入、错误映射、WS 退避、以及把 JSON 解成 `Models.ts` 的类型。
 *
 * 契约要点（详见 `docs/PORT-MAP.md` §2）：
 * - 端点全部挂在基地址根上，**不带任何前缀**（基地址已含 `/api/v1`）。
 * - 超时：连接 15s / 读 45s / 写 45s；WS ping 20s。
 * - WS 请求 URL 用**同源 http(s)**，由底层做协议升级，**不要**提前改写 `ws://`。
 * - WS 重连退避 `delay = (1<<retries) 封顶 30s`（1、2、4、8、16、30、30…）；重连后状态恢复始终靠 REST。
 * - 空体请求：GET 绝不带 body；POST/PUT/PATCH 的零长度体补 `{}`。
 */

import {
  AgentPreset, ChatHistory, ChatSession, ChatWorkspace, CommandDescriptor, CommandExecution,
  CreatedSession, CustomProviderCreate, DeviceView, DirectoryPage, DshApiException, FileContent,
  HealthView, ModelSelection, PairingResult, PendingApproval, PendingQuestionSet, PluginInventory,
  PluginToggleRequest, PluginToggleResult, PromptPart, ProviderModel, ProviderPatch,
  ProviderSettings, QuestionAnswer, QuestionAnswerRequest, RenamedSession, ResolvedPath,
  RootView, SessionModels, TrashEntry, UploadedAttachment, WorkspaceEvent,
} from './Models';
import { JsonAccess, JsonMap } from './JsonAccess';
import { normalizeEndpoint } from './EndpointUrl';
import { utf8Decode, utf8Encode } from './Codec';
import { messageBody, uploadPayload } from './ChatContentParts';

/** 连接超时（与上游 OkHttp 一致）。 */
export const CONNECT_TIMEOUT_MS: number = 15000;
/** 读超时。 */
export const READ_TIMEOUT_MS: number = 45000;
/** 写超时。 */
export const WRITE_TIMEOUT_MS: number = 45000;
/** WebSocket 心跳间隔。 */
export const WS_PING_INTERVAL_MS: number = 20000;
/** WS 退避上限。 */
export const WS_MAX_BACKOFF_SECONDS: number = 30;
/** 界面语言兜底（从未设置过时按中文，那是插件原本的口径）。 */
export const DEFAULT_LANGUAGE_TAG: string = 'zh-CN';

/**
 * 「这个路径打不开」的权威错误码集合 —— 都属于正常结果，不是故障。
 *
 * 刻意**不含**其他 404：`ROUTE_NOT_FOUND` 表示服务端压根没有这个端点（通常是插件版本过旧）。
 * 把它一并当成「不在授权根内」会把用户引向错误的方向 —— 他该做的是升级插件，而不是反复
 * 检查自己的路径。
 */
export const UNRESOLVABLE_CODES: string[] = [
  'PATH_OUTSIDE_ROOTS',
  'PATH_NOT_ABSOLUTE',
  'PATH_NOT_FILE',
  'PATH_NOT_FOUND',
];

export function isUnresolvableCode(code: string): boolean {
  for (let i = 0; i < UNRESOLVABLE_CODES.length; i++) {
    if (UNRESOLVABLE_CODES[i] === code) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 注入点
// ---------------------------------------------------------------------------

/** 一次 HTTP 请求的描述（平台无关）。 */
export class HttpRequest {
  method: string = 'GET';
  url: string = '';
  headers: Map<string, string> = new Map();
  /** GET/HEAD 必须为 null；其余方法零长度体按调用方约定给 `{}` 的字节。 */
  body: Uint8Array | null = null;
  connectTimeoutMs: number = CONNECT_TIMEOUT_MS;
  readTimeoutMs: number = READ_TIMEOUT_MS;
  writeTimeoutMs: number = WRITE_TIMEOUT_MS;

  constructor(method: string, url: string, headers: Map<string, string>, body: Uint8Array | null) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }
}

/**
 * 一次 HTTP 响应。
 *
 * **约定：`headers` 的键必须是小写**（平台层负责转小写）。这样 `header('ETag')` 这类
 * 大小写不敏感查询就不需要在逻辑层遍历 Map —— ArkTS 的 Map 迭代语法比 `get` 更容易踩坑。
 */
export class HttpResponse {
  status: number = 0;
  headers: Map<string, string> = new Map();
  body: Uint8Array = new Uint8Array(0);

  constructor(status: number, headers: Map<string, string>, body: Uint8Array) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  isSuccessful(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** 大小写不敏感地取响应头；键由平台层保证为小写。 */
  header(name: string): string | null {
    const key: string = name.toLowerCase();
    return this.headers.has(key) ? this.headers.get(key) as string : null;
  }

  text(): string {
    return utf8Decode(this.body);
  }
}

/** 平台传输实现：`@ohos.net.http`（或 rcp）达成。 */
export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** WS 事件回调；`onDown` 在关闭或失败时**恰好调用一次**。 */
export interface WebSocketCallbacks {
  onOpen(): void;

  onMessage(text: string): void;

  onDown(reason: string): void;
}

/** 已打开的 WS 句柄。 */
export interface EventSocketHandle {
  close(): void;
}

/**
 * 平台 WS 实现：给定 URL 与握手头，打开长连接。
 * 传入的 URL 是**同源 http(s)**；平台层负责协议升级（`@ohos.net.webSocket` 接受 http(s) URL）。
 */
export interface WebSocketTransport {
  open(url: string, headers: Map<string, string>, callbacks: WebSocketCallbacks): EventSocketHandle;
}

/** 延迟执行能力（替代协程调度器），供 WS 退避使用。 */
export interface TimerBridge {
  schedule(delayMs: number, action: () => void): number;

  cancel(handle: number): void;
}

/** 可关闭的事件订阅（对应上游返回的 `Closeable`）。 */
export interface EventsSubscription {
  close(): void;
}

/** 客户端的外部依赖（全部可注入，便于单测与平台替换）。 */
export interface DshClientDeps {
  /** 生成客户端请求 id（UUID v4）。 */
  newId(): string;

  /** 本机时区 id（如 `Asia/Shanghai`）。 */
  timeZoneId(): string;

  /** 当前界面语言（BCP-47，如 `zh-CN` / `en`）。 */
  languageTag(): string;

  /** 平台 WS 实现；不用事件推送时为 null。 */
  socket: WebSocketTransport | null;

  /** 平台定时器；不用事件推送时为 null。 */
  timers: TimerBridge | null;
}

// ---------------------------------------------------------------------------
// 事件通道（WS + 退避重连）
// ---------------------------------------------------------------------------

/**
 * 长连接事件通道。**重连后状态恢复始终靠 REST** —— 这里只负责「把帧送出去」与「掉线了告诉
 * 上层」，绝不假设补发能拼回完整状态。
 */
export class EventsChannel implements EventsSubscription {
  private url: string;
  private headers: Map<string, string>;
  private socket: WebSocketTransport;
  private timers: TimerBridge;
  private listener: (event: WorkspaceEvent) => void;
  private connectionListener: (open: boolean) => void;
  private closed: boolean = false;
  private retries: number = 0;
  private handle: EventSocketHandle | null = null;
  private timerHandle: number = -1;

  constructor(url: string, headers: Map<string, string>, socket: WebSocketTransport, timers: TimerBridge,
              listener: (event: WorkspaceEvent) => void, connectionListener: (open: boolean) => void) {
    this.url = url;
    this.headers = headers;
    this.socket = socket;
    this.timers = timers;
    this.listener = listener;
    this.connectionListener = connectionListener;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.closed) {
      return;
    }
    // 每次连接尝试独立一个终态标记：同一次尝试里 onDown 只处理一次
    // （平台层可能先报 onError 再报 onClose）。
    let terminal: boolean = false;
    const self: EventsChannel = this;
    this.handle = this.socket.open(this.url, this.headers, {
      onOpen: (): void => {
        self.retries = 0;
        self.connectionListener(true);
      },
      onMessage: (text: string): void => {
        const event: WorkspaceEvent | null = WorkspaceEvent.fromJsonText(text);
        if (event !== null) {
          self.listener(event);
        }
      },
      onDown: (): void => {
        if (terminal) {
          return;
        }
        terminal = true;
        if (self.closed) {
          return;
        }
        self.connectionListener(false);
        const delaySeconds: number = Math.min(1 << Math.min(self.retries, 5), WS_MAX_BACKOFF_SECONDS);
        self.retries += 1;
        self.timerHandle = self.timers.schedule(delaySeconds * 1000, (): void => self.connect());
      },
    });
  }

  close(): void {
    this.closed = true;
    this.connectionListener(false);
    if (this.timerHandle >= 0) {
      this.timers.cancel(this.timerHandle);
      this.timerHandle = -1;
    }
    if (this.handle !== null) {
      this.handle.close();
      this.handle = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/** 列表信封 `{items:[...]}` 取项。 */
function itemsOf(map: JsonMap | null): JsonMap[] {
  return JsonAccess.objArr(map, 'items');
}

/** 拼一个只含给定键值的 JSON 对象字符串（null 值由调用方过滤）。 */
function jsonObject(pairs: string[]): string {
  if (pairs.length === 0) {
    return '{}';
  }
  return `{${pairs.join(',')}}`;
}

function jsonPair(key: string, value: string): string {
  return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
}

export class DshClient {
  /** 归一化后的端点（含 `/api/v1`，无尾斜杠）。 */
  readonly endpoint: string;
  private base: string;
  private token: string | null;
  private http: HttpTransport;
  private deps: DshClientDeps;

  constructor(endpoint: string, token: string | null, http: HttpTransport, deps: DshClientDeps) {
    this.endpoint = normalizeEndpoint(endpoint);
    this.base = `${this.endpoint}/`;
    this.token = token;
    this.http = http;
    this.deps = deps;
  }

  // --- 健康检查 / 配对 / 设备 ------------------------------------------------

  health(): Promise<HealthView> {
    return this.getJson('healthz', false).then((map: JsonMap | null): HealthView => HealthView.fromJson(map));
  }

  pair(code: string, deviceName: string): Promise<PairingResult> {
    const body: string = jsonObject([jsonPair('code', code.trim()), jsonPair('deviceName', deviceName.trim())]);
    return this.postJson('pairings/exchange', body, false)
      .then((map: JsonMap | null): PairingResult => PairingResult.fromJson(map));
  }

  currentDevice(): Promise<DeviceView> {
    return this.getJson('devices/self', true).then((map: JsonMap | null): DeviceView => DeviceView.fromJson(map));
  }

  // --- 根 / 文件 --------------------------------------------------------------

  roots(): Promise<RootView[]> {
    return this.getJson('roots', true).then((map: JsonMap | null): RootView[] => {
      const raw: JsonMap[] = itemsOf(map);
      const out: RootView[] = [];
      for (let i = 0; i < raw.length; i++) {
        out.push(RootView.fromJson(raw[i]));
      }
      return out;
    });
  }

  entries(rootId: string, path: string = '', cursor: string | null = null): Promise<DirectoryPage> {
    let url: string = this.pathUrl(['roots', rootId, 'entries']);
    url += `?path=${encodeURIComponent(path)}`;
    if (cursor !== null) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }
    return this.getJsonUrl(url, true).then((map: JsonMap | null): DirectoryPage => DirectoryPage.fromJson(map));
  }

  readFile(rootId: string, path: string): Promise<FileContent> {
    const url: string = `${this.pathUrl(['roots', rootId, 'content'])}?path=${encodeURIComponent(path)}`;
    return this.send('GET', url, null, this.authHeaders()).then((res: HttpResponse): FileContent => {
      this.ensureSuccess(res);
      return new FileContent(res.body, res.header('ETag') ?? '', res.header('Content-Type'));
    });
  }

  /**
   * 写入文件内容，返回新的 `ETag`。
   *
   * `etag` 为 null 时带 `If-None-Match: *`（只在文件不存在时创建）；否则带 `If-Match`
   * 做乐观并发控制 —— 冲突时服务端回 409，调用方应提示用户「文件已被改动」。
   */
  writeFile(rootId: string, path: string, bytes: Uint8Array, etag: string | null = null): Promise<string> {
    const url: string = `${this.pathUrl(['roots', rootId, 'content'])}?path=${encodeURIComponent(path)}`;
    const headers: Map<string, string> = this.authHeaders();
    headers.set('Content-Type', 'application/octet-stream');
    if (etag === null) {
      headers.set('If-None-Match', '*');
    } else {
      headers.set('If-Match', etag);
    }
    return this.send('PUT', url, bytes, headers).then((res: HttpResponse): string => {
      this.ensureSuccess(res);
      return res.header('ETag') ?? '';
    });
  }

  createEntry(rootId: string, path: string, directory: boolean): Promise<void> {
    const body: string = jsonObject([jsonPair('path', path), jsonPair('kind', directory ? 'directory' : 'file')]);
    return this.postUnit(this.pathUrl(['roots', rootId, 'entries']), body);
  }

  moveEntry(rootId: string, path: string, destinationPath: string): Promise<void> {
    const body: string = jsonObject([jsonPair('path', path), jsonPair('destinationPath', destinationPath)]);
    return this.patchUnit(this.pathUrl(['roots', rootId, 'entries']), body);
  }

  trashEntry(rootId: string, path: string): Promise<void> {
    const url: string = `${this.pathUrl(['roots', rootId, 'entries'])}?path=${encodeURIComponent(path)}`;
    return this.send('DELETE', url, null, this.authHeaders())
      .then((res: HttpResponse): void => this.ensureSuccess(res));
  }

  trash(): Promise<TrashEntry[]> {
    return this.getJson('trash', true).then((map: JsonMap | null): TrashEntry[] => {
      const raw: JsonMap[] = itemsOf(map);
      const out: TrashEntry[] = [];
      for (let i = 0; i < raw.length; i++) {
        out.push(TrashEntry.fromJson(raw[i]));
      }
      return out;
    });
  }

  restoreTrash(id: string): Promise<void> {
    return this.postUnit(this.pathUrl(['trash', id, 'restore']), '{}');
  }

  // --- 会话与工作区 ----------------------------------------------------------

  sessions(): Promise<ChatSession[]> {
    return this.getJson('chat/sessions', true).then((map: JsonMap | null): ChatSession[] => {
      const raw: JsonMap[] = itemsOf(map);
      const out: ChatSession[] = [];
      for (let i = 0; i < raw.length; i++) {
        out.push(ChatSession.fromJson(raw[i]));
      }
      return out;
    });
  }

  chatWorkspaces(): Promise<ChatWorkspace[]> {
    return this.getJson('chat/workspaces', true).then((map: JsonMap | null): ChatWorkspace[] => {
      const raw: JsonMap[] = itemsOf(map);
      const out: ChatWorkspace[] = [];
      for (let i = 0; i < raw.length; i++) {
        out.push(ChatWorkspace.fromJson(raw[i]));
      }
      return out;
    });
  }

  createChatWorkspace(rootId: string, path: string): Promise<ChatWorkspace> {
    const body: string = jsonObject([jsonPair('rootId', rootId), jsonPair('path', path)]);
    return this.postJson('chat/workspaces', body, true).then((map: JsonMap | null): ChatWorkspace =>
      ChatWorkspace.fromJson(JsonAccess.obj(map, 'workspace')));
  }

  renameChatWorkspace(workspaceId: string, title: string): Promise<ChatWorkspace> {
    const body: string = jsonObject([jsonPair('title', title)]);
    return this.patchJson(this.pathUrl(['chat', 'workspaces', workspaceId]), body)
      .then((map: JsonMap | null): ChatWorkspace => ChatWorkspace.fromJson(JsonAccess.obj(map, 'workspace')));
  }

  deleteChatWorkspace(workspaceId: string): Promise<void> {
    const url: string = this.pathUrl(['chat', 'workspaces', workspaceId]);
    return this.send('DELETE', url, null, this.authHeaders())
      .then((res: HttpResponse): void => this.ensureSuccess(res));
  }

  agentPresets(): Promise<AgentPreset[]> {
    return this.getJson('chat/agent-presets', true).then((map: JsonMap | null): AgentPreset[] => {
      const raw: JsonMap[] = itemsOf(map);
      const out: AgentPreset[] = [];
      for (let i = 0; i < raw.length; i++) {
        out.push(AgentPreset.fromJson(raw[i]));
      }
      return out;
    });
  }

  selectAgentPreset(sessionId: string, agentPreset: string): Promise<string> {
    const body: string = jsonObject([jsonPair('agentPreset', agentPreset)]);
    return this.putJson(this.pathUrl(['chat', 'sessions', sessionId, 'agent-preset']), body)
      .then((map: JsonMap | null): string => JsonAccess.str(map, 'agentPreset') ?? '');
  }

  sessionModels(sessionId: string): Promise<SessionModels> {
    return this.getJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'models']), true)
      .then((map: JsonMap | null): SessionModels => SessionModels.fromJson(map));
  }

  selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    return this.putJson(this.pathUrl(['chat', 'sessions', sessionId, 'model']), selection.toJsonString())
      .then((map: JsonMap | null): ModelSelection => ModelSelection.fromJson(JsonAccess.obj(map, 'selected')));
  }

  /**
   * 把服务器绝对路径解析成 `rootId` + 相对路径。
   *
   * 返回 null 表示**服务端明确拒绝了这个路径**（`PATH_OUTSIDE_ROOTS` / `PATH_NOT_ABSOLUTE` /
   * `PATH_NOT_FILE` / `PATH_NOT_FOUND`），这在会话里是常态而不是故障：agent 完全可能提到授权
   * 根之外的文件。所以这些情况不抛异常，让调用方把「不可打开」当作正常结果展示。
   *
   * **但其他 404/400 必须抛出去**：服务端插件版本过旧时这个端点根本不存在，会返回
   * `404 ROUTE_NOT_FOUND`。若按状态码笼统地把所有 404 都当成「不在授权根内」，用户会去怀疑
   * 自己的路径，而真正该做的是升级插件。
   */
  resolvePath(absolutePath: string): Promise<ResolvedPath | null> {
    const url: string = `${this.urlOf('roots/resolve')}?path=${encodeURIComponent(absolutePath)}`;
    return this.send('GET', url, null, this.authHeaders())
      .then((res: HttpResponse): ResolvedPath | null => {
        if (res.isSuccessful()) {
          return ResolvedPath.fromJson(JsonAccess.asMap(JsonAccess.parse(res.text())));
        }
        const code: string = this.errorCodeOf(res);
        if (isUnresolvableCode(code)) {
          return null;
        }
        throw this.apiError(res, code);
      });
  }

  createSession(workspaceId: string, agentPreset: string | null = null): Promise<CreatedSession> {
    const pairs: string[] = [jsonPair('workspaceId', workspaceId), jsonPair('clientRequestId', this.deps.newId())];
    if (agentPreset !== null) {
      pairs.push(jsonPair('agentPreset', agentPreset));
    }
    return this.postJson('chat/sessions', jsonObject(pairs), true)
      .then((map: JsonMap | null): CreatedSession => CreatedSession.fromJson(JsonAccess.obj(map, 'session')));
  }

  renameSession(sessionId: string, title: string): Promise<RenamedSession> {
    const body: string = jsonObject([jsonPair('title', title)]);
    return this.patchJson(this.pathUrl(['chat', 'sessions', sessionId]), body)
      .then((map: JsonMap | null): RenamedSession => RenamedSession.fromJson(map));
  }

  forkSession(sessionId: string, atSeq: number | null = null): Promise<string> {
    const body: string = atSeq === null ? '{}' : jsonObject([`"atSeq":${atSeq}`]);
    return this.postJson(this.pathUrl(['chat', 'sessions', sessionId, 'fork']), body, true)
      .then((map: JsonMap | null): string => JsonAccess.str(map, 'sessionId') ?? '');
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.postUnit(this.pathUrl(['chat', 'sessions', sessionId, 'archive']), '{}');
  }

  history(sessionId: string, beforeSeq: number | null = null, maxMessages: number | null = null): Promise<ChatHistory> {
    let url: string = this.pathUrl(['chat', 'sessions', sessionId, 'messages']);
    let query: string = '';
    if (beforeSeq !== null) {
      query += `${query.length === 0 ? '?' : '&'}beforeSeq=${beforeSeq}`;
    }
    if (maxMessages !== null) {
      query += `${query.length === 0 ? '?' : '&'}maxMessages=${maxMessages}`;
    }
    url += query;
    return this.getJsonUrl(url, true).then((map: JsonMap | null): ChatHistory => ChatHistory.fromJson(map));
  }

  // --- 审批 ------------------------------------------------------------------

  pendingApprovals(sessionId: string): Promise<PendingApproval[]> {
    return this.getJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'approvals']), true)
      .then((map: JsonMap | null): PendingApproval[] => {
        const raw: JsonMap[] = itemsOf(map);
        const out: PendingApproval[] = [];
        for (let i = 0; i < raw.length; i++) {
          out.push(PendingApproval.fromJson(raw[i]));
        }
        return out;
      });
  }

  decideApproval(sessionId: string, approvalId: string, allowOnce: boolean): Promise<void> {
    const body: string = jsonObject([jsonPair('outcome', allowOnce ? 'allowed-once' : 'rejected')]);
    return this.postUnit(this.pathUrl(['chat', 'sessions', sessionId, 'approvals', approvalId, 'decision']), body);
  }

  // --- 问答 ------------------------------------------------------------------

  /**
   * 当前会话里待回答的问题（`ask_user_question`）。
   *
   * ⚠️ 服务端在这条路上会走 `resolveAgent(..., resume)` —— 对**冷**会话调它会把那边的 Agent
   * 拉活。所以调用方**只能**传当前打开的那个会话，绝不能拿它去遍历会话列表。
   */
  pendingQuestions(sessionId: string): Promise<PendingQuestionSet[]> {
    return this.getJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'questions']), true)
      .then((map: JsonMap | null): PendingQuestionSet[] => {
        const raw: JsonMap[] = itemsOf(map);
        const out: PendingQuestionSet[] = [];
        for (let i = 0; i < raw.length; i++) {
          out.push(PendingQuestionSet.fromJson(raw[i]));
        }
        return out;
      });
  }

  /**
   * 回答一组问题。
   *
   * 插件在「答复已经在队列里」（`QUESTION_REPLY_QUEUED`）与「这个问题已经不作答」
   * （`QUESTION_NOT_PENDING`）两种情况下回 409；调用方要把这两个 code 翻成人话。
   */
  answerQuestions(sessionId: string, callId: string, answers: QuestionAnswer[]): Promise<void> {
    const body: string = new QuestionAnswerRequest(answers).toJsonString();
    return this.postUnit(this.pathUrl(['chat', 'sessions', sessionId, 'questions', callId, 'answer']), body);
  }

  // --- 命令 ------------------------------------------------------------------

  sessionCommands(sessionId: string): Promise<CommandDescriptor[]> {
    return this.getJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'commands']), true)
      .then((map: JsonMap | null): CommandDescriptor[] => {
        const raw: JsonMap[] = itemsOf(map);
        const out: CommandDescriptor[] = [];
        for (let i = 0; i < raw.length; i++) {
          out.push(CommandDescriptor.fromJson(raw[i]));
        }
        return out;
      });
  }

  executeCommand(sessionId: string, line: string): Promise<CommandExecution> {
    const body: string = jsonObject([jsonPair('line', line)]);
    return this.postJson(this.pathUrl(['chat', 'sessions', sessionId, 'commands']), body, true)
      .then((map: JsonMap | null): CommandExecution => CommandExecution.fromJson(JsonAccess.obj(map, 'execution')));
  }

  // --- 发消息 / 附件 ---------------------------------------------------------

  /**
   * 发一条消息，内容是一个 part 列表（文本 / 内联图片 / 上传后的文件）。
   *
   * 请求体两种形状由 `ChatContentParts.messageBody` 决定：**纯文本走旧的 `{"text":...}`**，
   * 带附件才用 `{"content":[...]}`。服务端两种都吃，保持旧形状是为了不强迫老插件升级。
   */
  sendMessage(sessionId: string, parts: PromptPart[], steer: boolean): Promise<void> {
    const body: string = messageBody(parts, steer ? 'steer' : 'queue', this.deps.timeZoneId(), this.deps.newId());
    return this.postUnit(this.pathUrl(['chat', 'sessions', sessionId, 'messages']), body);
  }

  /** 纯文本重载：内部转成单个 text part，其余行为与线上格式都不变。 */
  sendText(sessionId: string, text: string, steer: boolean): Promise<void> {
    return this.sendMessage(sessionId, [PromptPart.text(text)], steer);
  }

  /**
   * 上传一个文件附件，换回消息里引用的 `receiptId`。
   *
   * 与「文件」页的 `writeFile` 是两套东西：那个是往工作区写文件，这个是给**这一条消息**换一张
   * 临时凭证，文件本身不进工作区。图片不需要走这里 —— 直接内联在消息里。
   */
  uploadAttachment(sessionId: string, bytes: Uint8Array, name: string): Promise<UploadedAttachment> {
    const body: string = uploadPayload(bytes, name);
    return this.postJson(this.pathUrl(['chat', 'sessions', sessionId, 'attachments']), body, true)
      .then((map: JsonMap | null): UploadedAttachment => UploadedAttachment.fromJson(map));
  }

  cancel(sessionId: string): Promise<void> {
    return this.postUnit(this.pathUrl(['chat', 'runs', sessionId, 'cancel']), '{}');
  }

  /**
   * 取回会话历史里某个图片附件的字节。
   *
   * 为什么历史图片需要这一步：发送时图片是 **base64 内联**在消息里的，但存进历史后被归一化成
   * `{type:'image', attachment:{attachmentId:'sha256:…'}}` —— 字节搬去了内核。
   * 所以「显示一张历史图片」永远是两步：先读事件拿 id，再来这里取字节。
   *
   * `attachmentId` 形如 `sha256:<hex>`，**含冒号**；路径段编码后是 `sha256%3A…`，这正是服务端
   * `decodeURIComponent` 期待的形式。必须带 `sessionId`：服务端走内核自己的
   * `sessionController.attachment({sessionId, attachmentId})`，它先读会话事件确认该会话引用了
   * 这张图、并取出**真实附件引用**（含 mediaType/bytes/width/height）再做完整性校验。
   * 早先只传 id 时缺四项元数据，每张图都抛 `ATTACHMENT_CORRUPT`（字节读到了却被拒之门外）。
   */
  readAttachment(sessionId: string, attachmentId: string): Promise<Uint8Array> {
    const url: string = `${this.pathUrl(['attachments', attachmentId])}?sessionId=${encodeURIComponent(sessionId)}`;
    return this.send('GET', url, null, this.authHeaders()).then((res: HttpResponse): Uint8Array => {
      this.ensureSuccess(res);
      return res.body;
    });
  }

  // --- 设置：供应商 ----------------------------------------------------------

  providerSettings(): Promise<ProviderSettings> {
    return this.getJson('settings/providers', true)
      .then((map: JsonMap | null): ProviderSettings => ProviderSettings.fromJson(map));
  }

  updateProvider(providerId: string, patch: ProviderPatch): Promise<ProviderSettings> {
    return this.patchJson(this.pathUrl(['settings', 'providers', providerId]), patch.toJsonString())
      .then((map: JsonMap | null): ProviderSettings => ProviderSettings.fromJson(map));
  }

  createCustomProvider(provider: CustomProviderCreate): Promise<ProviderSettings> {
    return this.postJson('settings/providers', provider.toJsonString(), true)
      .then((map: JsonMap | null): ProviderSettings => ProviderSettings.fromJson(map));
  }

  discoverModels(providerId: string, baseURL: string | null, api: string | null,
                 apiKey: string | null): Promise<ProviderModel[]> {
    const pairs: string[] = [];
    if (baseURL !== null) pairs.push(jsonPair('baseURL', baseURL));
    if (api !== null) pairs.push(jsonPair('api', api));
    if (apiKey !== null) pairs.push(jsonPair('apiKey', apiKey));
    return this.postJson(this.pathUrl(['settings', 'providers', providerId, 'discover']), jsonObject(pairs), true)
      .then((map: JsonMap | null): ProviderModel[] => {
        const raw: JsonMap[] = JsonAccess.objArr(map, 'models');
        const out: ProviderModel[] = [];
        for (let i = 0; i < raw.length; i++) {
          out.push(ProviderModel.fromJson(raw[i]));
        }
        return out;
      });
  }

  // --- 设置：插件 ------------------------------------------------------------

  pluginInventory(): Promise<PluginInventory> {
    return this.getJson('settings/plugins', true)
      .then((map: JsonMap | null): PluginInventory => PluginInventory.fromJson(map));
  }

  /**
   * 带版本检查地拉插件清单（`?checkUpdates=1`）。
   *
   * 与 `pluginInventory()` 分开是有意的：版本检查要对每个已装包发一次 registry 请求，清单会从
   * 毫秒级变成好几秒。用户点进「插件」页九成只想看「装了啥、哪个没启用」，所以默认走轻的那条，
   * 只有用户**主动要看更新**时才走这条。
   */
  pluginInventoryWithUpdates(): Promise<PluginInventory> {
    return this.getJson('settings/plugins?checkUpdates=1', true)
      .then((map: JsonMap | null): PluginInventory => PluginInventory.fromJson(map));
  }

  /**
   * 启用 / 停用一个插件。
   *
   * 服务端只改写 profile 的 `dsh.profile.bundles`（加载清单），**不碰依赖、不装包**，且写前会
   * 备份 profile 的 package.json。返回结果里的 `restartRequired` 恒为 true —— 那份清单只在 DSH
   * 启动时读一次，所以必须提示用户重启才生效。
   */
  setPluginLoaded(name: string, loaded: boolean): Promise<PluginToggleResult> {
    return this.patchJson(this.pathUrl(['settings', 'plugins']), new PluginToggleRequest(name, loaded).toJsonString())
      .then((map: JsonMap | null): PluginToggleResult => PluginToggleResult.fromJson(map));
  }

  // --- 事件流 ----------------------------------------------------------------

  /**
   * 打开事件流。平台未注入 WS 时抛错（调用方应改为轮询）。
   */
  events(listener: (event: WorkspaceEvent) => void, connection: (open: boolean) => void): EventsSubscription {
    if (this.deps.socket === null || this.deps.timers === null) {
      throw new Error('DshClient: 未注入 WebSocketTransport/TimerBridge，无法打开事件流');
    }
    const channel: EventsChannel = new EventsChannel(this.urlOf('events'), this.authHeaders(), this.deps.socket,
      this.deps.timers, listener, connection);
    channel.start();
    return channel;
  }

  /** WS 请求 URL：**同源 http(s)**，由底层做协议升级。 */
  eventsUrl(): string {
    return this.urlOf('events');
  }

  // --- 内部：URL / 头 / 错误 -------------------------------------------------

  private urlOf(relative: string): string {
    return this.base + relative;
  }

  private pathUrl(segments: string[]): string {
    let out: string = this.base;
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        out += '/';
      }
      out += encodeURIComponent(segments[i]);
    }
    return out;
  }

  private authHeaders(): Map<string, string> {
    const headers: Map<string, string> = new Map();
    headers.set('Accept', 'application/json');
    if (this.token === null) {
      throw new Error('DshClient: 该请求需要鉴权，但未提供设备令牌');
    }
    headers.set('Authorization', `Bearer ${this.token}`);
    // 界面语言随每个请求出海：服务端的图片交接说明要说**用户看得懂**的语言
    // （拿不到就按中文，那是插件原本的口径）。App 的语言由设置页管理，这里如实转达，
    // 不在客户端另做翻译。
    headers.set('Accept-Language', this.deps.languageTag());
    return headers;
  }

  private async send(method: string, url: string, body: Uint8Array | null,
                     headers: Map<string, string>): Promise<HttpResponse> {
    return this.http.request(new HttpRequest(method, url, headers, body));
  }

  /** 未鉴权请求：**不带任何头**（与上游一致：health / pairings 走裸请求）。 */
  private anonymousHeaders(): Map<string, string> {
    return new Map<string, string>();
  }

  private jsonBodyHeaders(authenticated: boolean): Map<string, string> {
    const headers: Map<string, string> = authenticated ? this.authHeaders() : this.anonymousHeaders();
    headers.set('Content-Type', 'application/json');
    return headers;
  }

  private async getJson(relative: string, authenticated: boolean): Promise<JsonMap | null> {
    return this.getJsonUrl(this.urlOf(relative), authenticated);
  }

  private async getJsonUrl(url: string, authenticated: boolean): Promise<JsonMap | null> {
    const headers: Map<string, string> = authenticated ? this.authHeaders() : this.anonymousHeaders();
    const res: HttpResponse = await this.send('GET', url, null, headers);
    this.ensureSuccess(res);
    return JsonAccess.asMap(JsonAccess.parse(res.text()));
  }

  private async postJson(relative: string, body: string, authenticated: boolean): Promise<JsonMap | null> {
    return this.postJsonUrl(this.urlOf(relative), body, authenticated);
  }

  private async postJsonUrl(url: string, body: string, authenticated: boolean): Promise<JsonMap | null> {
    const res: HttpResponse = await this.send('POST', url, utf8Encode(body), this.jsonBodyHeaders(authenticated));
    this.ensureSuccess(res);
    return JsonAccess.asMap(JsonAccess.parse(res.text()));
  }

  private async patchJson(url: string, body: string): Promise<JsonMap | null> {
    const res: HttpResponse = await this.send('PATCH', url, utf8Encode(body), this.jsonBodyHeaders(true));
    this.ensureSuccess(res);
    return JsonAccess.asMap(JsonAccess.parse(res.text()));
  }

  private async putJson(url: string, body: string): Promise<JsonMap | null> {
    const res: HttpResponse = await this.send('PUT', url, utf8Encode(body), this.jsonBodyHeaders(true));
    this.ensureSuccess(res);
    return JsonAccess.asMap(JsonAccess.parse(res.text()));
  }

  private async postUnit(url: string, body: string): Promise<void> {
    const res: HttpResponse = await this.send('POST', url, utf8Encode(body), this.jsonBodyHeaders(true));
    this.ensureSuccess(res);
  }

  private async patchUnit(url: string, body: string): Promise<void> {
    const res: HttpResponse = await this.send('PATCH', url, utf8Encode(body), this.jsonBodyHeaders(true));
    this.ensureSuccess(res);
  }

  /** 从错误响应体里取错误码；取不到时按上游口径返回 `HTTP_ERROR`。 */
  private errorCodeOf(res: HttpResponse): string {
    const error: JsonMap | null = JsonAccess.obj(JsonAccess.asMap(JsonAccess.parse(res.text())), 'error');
    return JsonAccess.str(error, 'code') ?? 'HTTP_ERROR';
  }

  private apiError(res: HttpResponse, code: string): DshApiException {
    const error: JsonMap | null = JsonAccess.obj(JsonAccess.asMap(JsonAccess.parse(res.text())), 'error');
    const message: string = JsonAccess.str(error, 'message') ?? `HTTP ${res.status}`;
    return new DshApiException(res.status, code, message);
  }

  /**
   * 非 2xx → 解析 `{error:{code,message,requestId?}}` → 抛 `DshApiException`。
   * GET/HEAD 不带 body 的约定由调用方保证；这里只做「成功/失败」判定。
   */
  private ensureSuccess(res: HttpResponse): void {
    if (res.isSuccessful()) {
      return;
    }
    throw this.apiError(res, this.errorCodeOf(res));
  }
}
