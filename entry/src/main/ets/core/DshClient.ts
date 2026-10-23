/**
 * DSH 服务端客户端 —— 移植自原工程 `data/DshClient.kt`（653 行）。
 *
 * 分层原则（本文件最重要的设计决定）：**逻辑层不碰任何平台 API**。
 * 原工程直接用 OkHttp + OkHttp WebSocket；鸿蒙侧对应 `@ohos.net.http` / `@ohos.net.webSocket`，
 * 但把那些 API 焊进业务逻辑里，就没法离线单测，也没法在 node 下跑契约测试。
 * 所以这里抽出两个注入点：
 * - `HttpTransport`：一次请求 → 一次响应（含超时元数据）；
 * - `WebSocketTransport` + `TimerBridge`：长连接与「延迟重连」的定时能力。
 * 逻辑层只负责：URL 拼装、鉴权头注入、错误映射、以及把 JSON 解成 `Models.ts` 的类型。
 *
 * ## 拆分说明（2026-10-20）
 *
 * 加入后台任务三个端点后本文件越过 900 行预算（见 `docs/TECH-DEBT.md` §行数预算），
 * 遂把**传输侧**整体搬到 `core/DshTransport.ts`：超时常量、`HttpRequest` / `HttpResponse`、
 * 三个平台注入接口、`DshClientDeps`、以及 `EventsChannel`（WS 退避重连）。
 * 搬的是「平台能给我什么」，留下的是「业务怎么用」—— 后者才是本文件的名字所暗示的内容。
 * 下面那段 `export { … } from './DshTransport'` 让**所有既有 import 一个字都不用改**
 * （平台层 `import { HttpTransport } from '../core/DshClient'` 照旧成立）。
 *
 * 契约要点（详见 `docs/PORT-MAP.md` §2）：
 * - 端点全部挂在基地址根上，**不带任何前缀**（基地址已含 `/api/v1`）。
 * - 超时：连接 15s / 读 45s / 写 45s；WS ping 20s。
 * - WS 请求 URL 用**同源 http(s)**，由底层做协议升级，**不要**提前改写 `ws://`。
 * - WS 重连退避 `delay = (1<<retries) 封顶 30s`（1、2、4、8、16、30、30…）；重连后状态恢复始终靠 REST。
 * - 空体请求：GET 绝不带 body；POST/PUT/PATCH 的零长度体补 `{}`。
 * - **拼 URL 的两种后缀别用错**（详见坑 50）：`postJson(相对路径)` 与
 *   `postJsonUrl(完整URL)` 名字长得像，喂错参数会拼出**双份基地址**。
 */

import {
  AgentPreset, ChatHistory, ChatSession, ChatWorkspace, CommandDescriptor, CommandExecution,
  CreatedSession, CustomProviderCreate, DeviceView, DirectoryPage, DshApiException, FileContent,
  HealthView, ModelSelection, PairingResult, PendingApproval, PendingQuestionSet,
  PermissionCatalog, PluginInventory,
  PluginToggleRequest, PluginToggleResult, PromptPart, ProviderModel, ProviderPatch,
  ProviderSettings, QuestionAnswer, QuestionAnswerRequest, RenamedSession, ResolvedPath,
  RootView, SessionModels, TrashEntry, UploadedAttachment,
} from './Models';
import { JobKillResult, JobOutput, JobView } from './JobViews';
import { JsonAccess, JsonMap } from './JsonAccess';
import { normalizeEndpoint } from './EndpointUrl';
import { utf8Encode } from './Codec';
import { SettingsSchema } from './SettingsSchema';
import { messageBody, uploadPayload } from './ChatContentParts';

// 传输注入点整体在 `core/DshTransport.ts`；这里原样转发，保住全部既有 import 路径。
// **接口必须走 `export type`**：它们是纯类型，用 `export {}` 转发在 ESM 运行时会报
// 「does not provide an export named …」（tsx / node 单测直接红）。类与常量走普通 `export {}`。
export {
  CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, WS_PING_INTERVAL_MS, WS_MAX_BACKOFF_SECONDS,
  DEFAULT_LANGUAGE_TAG, HttpRequest, HttpResponse, EventsChannel,
} from './DshTransport';
export type {
  HttpTransport, WebSocketCallbacks, EventSocketHandle, WebSocketTransport,
  TimerBridge, EventsSubscription, DshClientDeps,
} from './DshTransport';
import {
  DshClientDeps, EventsChannel, EventsSubscription, HttpRequest, HttpResponse, HttpTransport,
} from './DshTransport';
import { WorkspaceEvent } from './Models';

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

  /**
   * 会话列表；`archived = true` 时**只列已归档**的那批（`?archived=true`）。
   *
   * 老服务端会**忽略**这个参数并返回未归档列表 —— 所以调用方（`loadArchivedSessions`）
   * 必须先按能力位 `session-archive-list-v1` 把关，否则会展示出「一条归档都没有」的假结论。
   */
  sessions(archived: boolean = false): Promise<ChatSession[]> {
    const path: string = archived ? 'chat/sessions?archived=true' : 'chat/sessions';
    return this.getJson(path, true).then((map: JsonMap | null): ChatSession[] => {
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
    return this.postJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'fork']), body, true)
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
    return this.postJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'commands']), body, true)
      .then((map: JsonMap | null): CommandExecution => CommandExecution.fromJson(JsonAccess.obj(map, 'execution')));
  }

  // --- 后台任务（bridge ≥ 2.4.3） ---------------------------------------------

  /**
   * 某会话可见的后台任务清单（`GET /chat/sessions/{sessionId}/jobs`）。
   *
   * 返回的是**完整清单**：服务端只读内核 roster 流的第一帧，内核保证
   * 「Whole-set replacement, so a reconnect's first frame is already the truth」。
   * 所以这里没有分页，也没有游标 —— 拉一次就是全部。
   *
   * 端点是**会话维度**的，不是顶层 `/jobs`：内核的 list/kill 都要 `sessionId`
   * （返回「该会话自己的任务 + 所有无主任务」），owner fence 是唯一的访问规则。
   * 做成顶层端点就得让客户端额外猜一个 session，那会把围栏语义搬到桥外面。
   *
   * 老 bridge 没有这条路由（404 `ROUTE_NOT_FOUND`），调用方必须先按能力位
   * `job-list-v1` 把关（`core/BridgeCapabilities.supportsJobListing`）。
   *
   * 空清单是正常结果（这个会话确实没有任务），不是失败；失败走 `DshApiException`。
   */
  sessionJobs(sessionId: string): Promise<JobView[]> {
    return this.getJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'jobs']), true)
      .then((map: JsonMap | null): JobView[] => {
        // 信封是 `{ jobs: [...] }`（不是别处那条 `{items:[...]}`）—— 与源工程
        // `JobListEnvelope(val jobs: List<JobView>)` 逐字对齐。
        const raw: JsonMap[] = JsonAccess.objArr(map, 'jobs');
        const out: JobView[] = [];
        for (let i = 0; i < raw.length; i++) {
          out.push(JobView.fromJson(raw[i]));
        }
        return out;
      });
  }

  /**
   * 读一个后台任务已保留的输出（`GET .../jobs/{jobId}/output`）。
   *
   * `from` 是**绝对字节偏移**：传上一次返回的 `JobOutput.next` 即增量续读，
   * null 从最旧的保留字节开始。任务留存策略可能丢旧字节，丢过就会在
   * `JobOutput.lossy` 上标记 —— 界面必须提示「这不是完整输出」。
   */
  jobOutput(sessionId: string, jobId: string, from: number | null = null): Promise<JobOutput> {
    let url: string = this.pathUrl(['chat', 'sessions', sessionId, 'jobs', jobId, 'output']);
    if (from !== null) {
      url += `?from=${from}`;
    }
    return this.getJsonUrl(url, true)
      .then((map: JsonMap | null): JobOutput => JobOutput.fromJson(map));
  }

  /**
   * 终止一个后台任务（`POST .../jobs/{jobId}/kill`）。
   *
   * 两种成功语义必须区分：`requested`（已受理）与 `already-finished`
   * （已是终态、无需再杀）。后者要显示「它已经结束了」—— 用户在远程场景下
   * 看到这句话才知道**不用再管了**，与「已终止」不是一回事。
   * 任务不存在或本会话看不到它时服务端返回 404 `JOB_NOT_FOUND`。
   */
  killJob(sessionId: string, jobId: string): Promise<JobKillResult> {
    // 用 `postJsonUrl`（吃完整 URL）而不是 `postJson`（会把基地址再拼一次）——
    // 见 PORT-MAP 坑 50：`postJson(this.pathUrl(...))` 会拼出双份基地址。
    return this.postJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'jobs', jobId, 'kill']), '{}', true)
      .then((map: JsonMap | null): JobKillResult => JobKillResult.fromJson(map));
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
    return this.postJsonUrl(this.pathUrl(['chat', 'sessions', sessionId, 'attachments']), body, true)
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

  /**
   * `DELETE settings/providers/{id}` —— 删除自定义供应商。
   *
   * 仅 `ProviderView.removable === true` 的供应商可删（内置供应商不可删）。
   * 返回更新后的 ProviderSettings。
   */
  deleteProvider(providerId: string): Promise<ProviderSettings> {
    return this.deleteJson(this.pathUrl(['settings', 'providers', providerId]))
      .then((): Promise<ProviderSettings> => this.providerSettings());
  }

  /**
   * 重置供应商的模型列表为「继承服务端默认」。
   *
   * **不是** `POST .../reset-models` —— bridge 2.5.2 根本没有这条路由（只有
   * PATCH / DELETE / discover 三条）。等效做法是 `PATCH {"models": null}`：
   * 服务端把 `models === null` 翻成 `unset models` 操作，删掉覆盖值后自然回落到继承。
   *
   * 请求体必须手写，不能走 `ProviderPatch` —— 那里 `models: null` 的语义是
   * 「字段不出现」（保持原状），恰好与这里要的「显式置空」相反。
   */
  resetProviderModels(providerId: string): Promise<ProviderSettings> {
    return this.patchJson(this.pathUrl(['settings', 'providers', providerId]), '{"models":null}')
      .then((map: JsonMap | null): ProviderSettings => ProviderSettings.fromJson(map));
  }

  discoverModels(providerId: string, baseURL: string | null, api: string | null,
                 apiKey: string | null): Promise<ProviderModel[]> {
    const pairs: string[] = [];
    if (baseURL !== null) pairs.push(jsonPair('baseURL', baseURL));
    if (api !== null) pairs.push(jsonPair('api', api));
    if (apiKey !== null) pairs.push(jsonPair('apiKey', apiKey));
    return this.postJsonUrl(this.pathUrl(['settings', 'providers', providerId, 'discover']), jsonObject(pairs), true)
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
   * 权限档位**候选项**目录（`GET /chat/permission-presets`，bridge ≥ 2.4.2）。
   *
   * ## 为什么必须单独取、不能只读会话投影
   *
   * 内核把预设清单放在一个独立的远程服务（`permissionPresets.catalog()`）上，
   * 而投影里那条 `permissions` wire 视图**只给 `currentValue`**
   * （`wire.view: state => ({ currentValue })`）——拿得到当前档位、列不出候选。
   * 源工程 v2.2.44 之前读投影里的 `options[]`，于是整条恒为空、
   * 权限 Pill 与 ⋯ 菜单的权限项在真机上**从不渲染**。
   *
   * ## 老 bridge 必须容忍失败
   *
   * 老 bridge 没有这条路由，会回 404 `ROUTE_NOT_FOUND`。**这里不抛错，返回 null**：
   * 目录是「锦上添花」——没有它，界面仍要渲染一个**不可点**的当前档位标签
   * （用户至少看得见自己在什么档位上），而调用方也就能照常连接。
   * 抛出去的话，一次目录拉取失败会连累整个连接流程。
   */
  async permissionPresets(): Promise<PermissionCatalog | null> {
    try {
      const map: JsonMap | null = await this.getJson('chat/permission-presets', true);
      return PermissionCatalog.fromJson(map);
    } catch (failure) {
      if (failure instanceof DshApiException && failure.code === 'ROUTE_NOT_FOUND') {
        return null;
      }
      throw failure;
    }
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

  // --- 设置：命名空间 schema（bridge ≥ 2.6.0） -------------------------------

  /**
   * `GET /settings/namespaces` —— 拉取设置命名空间的 schema 定义 + 当前值。
   *
   * 老 bridge 没有这条路由会回 404 `ROUTE_NOT_FOUND`；**调用方必须容忍**
   * （见 `SettingsSchema.isSilentSettingsNamespaceError`）。返回 null 表示解析失败
   * 或空响应，状态层据此不画入口（三层降级第一层）。
   */
  settingsNamespaces(): Promise<SettingsSchema | null> {
    return this.getJson('settings/namespaces', true)
      .then((map: JsonMap | null): SettingsSchema | null => {
        if (map === null) {
          return null;
        }
        const namespace: string = JsonAccess.str(map, 'namespace') ?? 'default';
        const revision: number = JsonAccess.num(map, 'revision') ?? 0;
        const fields: JsonMap[] = JsonAccess.objArr(map, 'fields');
        const values: JsonMap | null = JsonAccess.obj(map, 'values');
        return SettingsSchema.parse(namespace, revision, fields, values);
      });
  }

  /**
   * `PATCH /settings/namespaces/{ns}` —— 提交设置改动。
   *
   * `ops` 由 `buildSettingsOps(schema, draft)` 生成，密钥位永不进 ops。
   * 返回更新后的 schema（含新 revision）。
   */
  patchSettingsNamespace(namespace: string, ops: JsonMap): Promise<SettingsSchema | null> {
    return this.patchJson(this.pathUrl(['settings', 'namespaces', namespace]), JSON.stringify(ops))
      .then((map: JsonMap | null): SettingsSchema | null => {
        if (map === null) {
          return null;
        }
        const ns: string = JsonAccess.str(map, 'namespace') ?? namespace;
        const revision: number = JsonAccess.num(map, 'revision') ?? 0;
        const fields: JsonMap[] = JsonAccess.objArr(map, 'fields');
        const values: JsonMap | null = JsonAccess.obj(map, 'values');
        return SettingsSchema.parse(ns, revision, fields, values);
      });
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

  private async deleteJson(url: string): Promise<void> {
    const res: HttpResponse = await this.send('DELETE', url, null, this.authHeaders());
    this.ensureSuccess(res);
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
