/**
 * 服务端线上模型（wire models）—— 移植自原工程 `data/Models.kt`（544 行）。
 *
 * 三条贯穿全文件的规矩，全部来自上游踩过的坑，改动前请先读：
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

import { JsonAccess, JsonMap } from './JsonAccess';

/**
 * 请求体 JSON 拼装助手：null 一律省略（见文件头第 2 条）。
 * 只用于「出站」请求体；入站解码一律走 `JsonAccess`。
 * 嵌套数组请传「对象映射数组」（`JsonMap[]`），别传已序列化的字符串 —— 那会被再次转义。
 */
class WireBuilder {
  private map: JsonMap = {};

  /** 非 null 才写入；null 表示「不指定该字段」。 */
  put(key: string, value: Object | null): WireBuilder {
    if (value !== null) {
      this.map[key] = value;
    }
    return this;
  }

  /** 条件写入：仅在 flag 为 true 时写。 */
  putIf(flag: boolean, key: string, value: Object | null): WireBuilder {
    return flag ? this.put(key, value) : this;
  }

  buildMap(): JsonMap {
    return this.map;
  }

  build(): string {
    return JSON.stringify(this.map);
  }
}

/** 把一组「已序列化的 JSON 片段」拼成数组字符串，空数组返回 `[]`。 */
function encodeArrayOf(fragments: string[]): string {
  if (fragments.length === 0) {
    return '[]';
  }
  let out: string = '[';
  for (let i = 0; i < fragments.length; i++) {
    if (i > 0) {
      out += ',';
    }
    out += fragments[i];
  }
  return `${out}]`;
}

/** 对象映射数组：嵌入父对象时用它，避免「把已序列化字符串当值」的二次转义。 */
export type JsonMapArray = JsonMap[];

// ---------------------------------------------------------------------------
// 健康检查 / 根 / 设备 / 配对
// ---------------------------------------------------------------------------

export class HealthView {
  ok: boolean = false;
  version: string = '';
  pluginVersion: string | null = null;

  static fromJson(map: JsonMap | null): HealthView {
    const v: HealthView = new HealthView();
    v.ok = JsonAccess.bool(map, 'ok') ?? false;
    v.version = JsonAccess.str(map, 'version') ?? '';
    v.pluginVersion = JsonAccess.str(map, 'pluginVersion');
    return v;
  }
}

export class RootView {
  id: string = '';
  label: string = '';
  createdAt: number = 0;

  static fromJson(map: JsonMap | null): RootView {
    const v: RootView = new RootView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.label = JsonAccess.str(map, 'label') ?? '';
    v.createdAt = JsonAccess.num(map, 'createdAt') ?? 0;
    return v;
  }
}

export class DeviceView {
  id: string = '';
  name: string = '';
  scopes: string[] = [];
  rootIds: string[] = [];

  static fromJson(map: JsonMap | null): DeviceView {
    const v: DeviceView = new DeviceView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.scopes = JsonAccess.strArr(map, 'scopes');
    v.rootIds = JsonAccess.strArr(map, 'rootIds');
    return v;
  }
}

export class PairingResult {
  token: string = '';
  device: DeviceView = new DeviceView();

  static fromJson(map: JsonMap | null): PairingResult {
    const v: PairingResult = new PairingResult();
    v.token = JsonAccess.str(map, 'token') ?? '';
    v.device = DeviceView.fromJson(JsonAccess.obj(map, 'device'));
    return v;
  }
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

export class FileEntry {
  name: string = '';
  path: string = '';
  /** `file` 或 `directory`；未知取值由界面兜底，不在这里抛错。 */
  kind: string = '';
  size: number = 0;
  modifiedAt: number = 0;
  writable: boolean = false;

  isDirectory(): boolean {
    return this.kind === 'directory';
  }

  /**
   * 只改 `size` 的副本。
   *
   * 为 `HarnessViewModel.replaceSelected` 补：上传替换成功后要把本地这条条目的大小
   * 改成刚写出去的长度（对应 Kotlin `document.entry.copy(size = length)`），
   * 好让面板按新尺寸重新判「要不要跳过预览」。
   */
  withSize(size: number): FileEntry {
    const v: FileEntry = new FileEntry();
    v.name = this.name;
    v.path = this.path;
    v.kind = this.kind;
    v.size = size;
    v.modifiedAt = this.modifiedAt;
    v.writable = this.writable;
    return v;
  }

  static fromJson(map: JsonMap | null): FileEntry {
    const v: FileEntry = new FileEntry();
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.path = JsonAccess.str(map, 'path') ?? '';
    v.kind = JsonAccess.str(map, 'kind') ?? '';
    v.size = JsonAccess.num(map, 'size') ?? 0;
    v.modifiedAt = JsonAccess.num(map, 'modifiedAt') ?? 0;
    v.writable = JsonAccess.bool(map, 'writable') ?? false;
    return v;
  }
}

export class DirectoryPage {
  path: string = '';
  entries: FileEntry[] = [];
  nextCursor: string | null = null;

  /**
   * 只改「条目列表 + 下一页游标」的副本。
   *
   * 为 `HarnessViewModel.loadNextDirectoryPage` 补：对应 Kotlin
   * `current.copy(entries = 合并去重后的, nextCursor = next.nextCursor)` ——
   * 翻页只追加条目、换游标，`path` 等字段原样保留。
   */
  withMerged(entries: FileEntry[], nextCursor: string | null): DirectoryPage {
    const v: DirectoryPage = new DirectoryPage();
    v.path = this.path;
    v.entries = entries;
    v.nextCursor = nextCursor;
    return v;
  }

  static fromJson(map: JsonMap | null): DirectoryPage {
    const v: DirectoryPage = new DirectoryPage();
    v.path = JsonAccess.str(map, 'path') ?? '';
    const raw: JsonMap[] = JsonAccess.objArr(map, 'entries');
    for (let i = 0; i < raw.length; i++) {
      v.entries.push(FileEntry.fromJson(raw[i]));
    }
    v.nextCursor = JsonAccess.str(map, 'nextCursor');
    return v;
  }
}

/**
 * `GET roots/resolve?path=<绝对路径>` 的响应：把一个**服务器绝对路径**翻译成
 * 「它属于哪个授权根 + 相对路径」。
 *
 * 为什么需要服务端代劳：会话事件里的路径是绝对路径，而 `roots` 刻意不返回根的绝对路径，
 * 客户端没有足够信息自己完成映射；把绝对路径直接喂给 `roots/:id/content` 又会被
 * `PATH_INVALID` 拒绝。响应里**依然不含根的绝对路径**，安全性没有被削弱。
 *
 * `size` / `contentType` 在服务端是 `number | null` / `string | null`：目录没有大小和内容
 * 类型，服务端会**显式发送 `null`**，所以必须可空。
 */
export class ResolvedPath {
  rootId: string = '';
  path: string = '';
  kind: string = '';
  size: number | null = null;
  modifiedAt: number = 0;
  contentType: string | null = null;

  static fromJson(map: JsonMap | null): ResolvedPath {
    const v: ResolvedPath = new ResolvedPath();
    v.rootId = JsonAccess.str(map, 'rootId') ?? '';
    v.path = JsonAccess.str(map, 'path') ?? '';
    v.kind = JsonAccess.str(map, 'kind') ?? '';
    v.size = JsonAccess.num(map, 'size');
    v.modifiedAt = JsonAccess.num(map, 'modifiedAt') ?? 0;
    v.contentType = JsonAccess.str(map, 'contentType');
    return v;
  }
}

export class TrashEntry {
  id: string = '';
  rootId: string = '';
  path: string = '';
  kind: string = '';
  size: number = 0;
  createdAt: number = 0;
  status: string = '';

  static fromJson(map: JsonMap | null): TrashEntry {
    const v: TrashEntry = new TrashEntry();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.rootId = JsonAccess.str(map, 'rootId') ?? '';
    v.path = JsonAccess.str(map, 'path') ?? '';
    v.kind = JsonAccess.str(map, 'kind') ?? '';
    v.size = JsonAccess.num(map, 'size') ?? 0;
    v.createdAt = JsonAccess.num(map, 'createdAt') ?? 0;
    v.status = JsonAccess.str(map, 'status') ?? '';
    return v;
  }
}

/** 文件内容 + 版本标识（`GET roots/{id}/content`，字节流 + ETag / Content-Type 头）。 */
export class FileContent {
  bytes: Uint8Array;
  etag: string;
  contentType: string | null;

  constructor(bytes: Uint8Array = new Uint8Array(0), etag: string = '', contentType: string | null = null) {
    this.bytes = bytes;
    this.etag = etag;
    this.contentType = contentType;
  }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export class ChatSession {
  id: string = '';
  rootId: string = '';
  /**
   * 会话工作目录**相对授权根**的路径 —— 列举接口要的正是它。
   *
   * **空字符串是合法值**：工作目录正好就是授权根本身时，相对路径就是空的。别把空串当
   * 「没有工作目录」丢掉，那会让 `@` 补全在根目录下直接瘫痪。
   */
  cwd: string = '';
  /**
   * 工作目录的**绝对路径**（老服务端不返回时为 null）。`@` 要往输入框里插绝对路径，
   * 而客户端手里没有根的 realPath（`RootView` 刻意不含它）——这个字段就是那条缺失的桥。
   */
  cwdAbsolute: string | null = null;
  updatedAt: number = 0;
  running: boolean = false;
  blank: boolean = false;
  title: string | null = null;
  workspaceId: string | null = null;
  workspaceTitle: string | null = null;
  agentPreset: string | null = null;
  parentSessionId: string | null = null;
  origin: string | null = null;
  pendingInteraction: string | null = null;

  /** 列表里显示用的标题：空标题回退成「未命名会话」占位由界面决定，这里只给原文。 */
  displayTitle(): string {
    return this.title === null ? '' : this.title;
  }

  /**
   * 只改 `running` 的副本。
   *
   * 为 `HarnessViewModel.markSessionStopped` 补：Kotlin 那边是 `data class` 的
   * `copy(running = false)`，ArkTS 没有 `copy()` 这种机器，所以给一个最小的方法，
   * 语义与 `copy(running = ...)` 一字不差（其余字段原样拷过去，不改自身）。
   */
  withRunning(running: boolean): ChatSession {
    const v: ChatSession = this.cloneBase();
    v.running = running;
    return v;
  }

  /** 逐字段拷贝出一个新对象（与 `Host.copy()` 同一种写法，不用 JSON 往返）。 */
  private cloneBase(): ChatSession {
    const v: ChatSession = new ChatSession();
    v.id = this.id;
    v.rootId = this.rootId;
    v.cwd = this.cwd;
    v.cwdAbsolute = this.cwdAbsolute;
    v.updatedAt = this.updatedAt;
    v.running = this.running;
    v.blank = this.blank;
    v.title = this.title;
    v.workspaceId = this.workspaceId;
    v.workspaceTitle = this.workspaceTitle;
    v.agentPreset = this.agentPreset;
    v.parentSessionId = this.parentSessionId;
    v.origin = this.origin;
    v.pendingInteraction = this.pendingInteraction;
    return v;
  }

  static fromJson(map: JsonMap | null): ChatSession {
    const v: ChatSession = new ChatSession();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.rootId = JsonAccess.str(map, 'rootId') ?? '';
    v.cwd = JsonAccess.str(map, 'cwd') ?? '';
    v.cwdAbsolute = JsonAccess.str(map, 'cwdAbsolute');
    v.updatedAt = JsonAccess.num(map, 'updatedAt') ?? 0;
    v.running = JsonAccess.bool(map, 'running') ?? false;
    v.blank = JsonAccess.bool(map, 'blank') ?? false;
    v.title = JsonAccess.str(map, 'title');
    v.workspaceId = JsonAccess.str(map, 'workspaceId');
    v.workspaceTitle = JsonAccess.str(map, 'workspaceTitle');
    v.agentPreset = JsonAccess.str(map, 'agentPreset');
    v.parentSessionId = JsonAccess.str(map, 'parentSessionId');
    v.origin = JsonAccess.str(map, 'origin');
    v.pendingInteraction = JsonAccess.str(map, 'pendingInteraction');
    return v;
  }
}

export class CreatedSession {
  id: string = '';
  agentPreset: string | null = null;

  static fromJson(map: JsonMap | null): CreatedSession {
    const v: CreatedSession = new CreatedSession();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.agentPreset = JsonAccess.str(map, 'agentPreset');
    return v;
  }
}

export class RenamedSession {
  title: string = '';
  seq: number = 0;

  static fromJson(map: JsonMap | null): RenamedSession {
    const v: RenamedSession = new RenamedSession();
    v.title = JsonAccess.str(map, 'title') ?? '';
    v.seq = JsonAccess.num(map, 'seq') ?? 0;
    return v;
  }
}

export class ChatWorkspace {
  id: string = '';
  title: string = '';
  rootId: string = '';
  path: string = '';
  /** 服务端给的是 ISO 时间串（不是毫秒），保持字符串不做折算。 */
  createdAt: string = '';
  updatedAt: string = '';

  static fromJson(map: JsonMap | null): ChatWorkspace {
    const v: ChatWorkspace = new ChatWorkspace();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.title = JsonAccess.str(map, 'title') ?? '';
    v.rootId = JsonAccess.str(map, 'rootId') ?? '';
    v.path = JsonAccess.str(map, 'path') ?? '';
    v.createdAt = JsonAccess.str(map, 'createdAt') ?? '';
    v.updatedAt = JsonAccess.str(map, 'updatedAt') ?? '';
    return v;
  }
}

export class AgentPreset {
  id: string = '';
  name: string = '';
  description: string | null = null;
  /**
   * DSH 0.2.x 去掉了 `system`/`user` 的 trust 分裂：`AgentPresetRow` 里根本没这个字段，
   * 严格解码器曾因此整份列表报 "Field 'trust' is required"。默认 "system" 兜底。
   */
  trust: string = 'system';
  isDefault: boolean = false;
  available: boolean = true;

  static fromJson(map: JsonMap | null): AgentPreset {
    const v: AgentPreset = new AgentPreset();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.description = JsonAccess.str(map, 'description');
    v.trust = JsonAccess.str(map, 'trust') ?? 'system';
    v.isDefault = JsonAccess.bool(map, 'isDefault') ?? false;
    v.available = JsonAccess.bool(map, 'available') ?? true;
    return v;
  }
}

// ---------------------------------------------------------------------------
// 审批
// ---------------------------------------------------------------------------

export class PendingApproval {
  id: string = '';
  sessionId: string = '';
  toolName: string = '';
  reason: string | null = null;
  detail: string | null = null;
  risk: string = '';
  requestedAt: number = 0;

  static fromJson(map: JsonMap | null): PendingApproval {
    const v: PendingApproval = new PendingApproval();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.sessionId = JsonAccess.str(map, 'sessionId') ?? '';
    v.toolName = JsonAccess.str(map, 'toolName') ?? '';
    v.reason = JsonAccess.str(map, 'reason');
    v.detail = JsonAccess.str(map, 'detail');
    v.risk = JsonAccess.str(map, 'risk') ?? '';
    v.requestedAt = JsonAccess.num(map, 'requestedAt') ?? 0;
    return v;
  }
}

/** 审批决定：只允许「本次放行」或「拒绝」，没有「永久放行」。 */
export const APPROVAL_OUTCOME_ALLOWED_ONCE: string = 'allowed-once';
export const APPROVAL_OUTCOME_REJECTED: string = 'rejected';

// ---------------------------------------------------------------------------
// 问答（ask_user_question）
// ---------------------------------------------------------------------------

/** 唯一支持远程回答的状态（见 `PendingQuestionSet` 说明）。 */
export const QUESTION_STATE_CONTINUED: string = 'continued';

export class QuestionOption {
  label: string = '';
  description: string | null = null;

  static fromJson(map: JsonMap | null): QuestionOption {
    const v: QuestionOption = new QuestionOption();
    v.label = JsonAccess.str(map, 'label') ?? '';
    v.description = JsonAccess.str(map, 'description');
    return v;
  }
}

/**
 * 一道待答问题。
 *
 * `intent`（如 plan-review）刻意**不建模**：内核明确说它只影响呈现、永不改变协议，
 * 命中与否都按普通选项渲染 —— 特判只会多出一个会过期的分支。
 */
export class ChatQuestion {
  /** 回传时必须**原样带回**的题目 id。 */
  id: string = '';
  question: string = '';
  header: string | null = null;
  detail: string | null = null;
  /** 空数组表示这题要自由文本（对应 `QuestionAnswer.custom`）。 */
  options: QuestionOption[] = [];
  /**
   * 单选还是多选，由**提问方**声明。缺省 false（单选）。UI 不许自己猜
   * （比如「选项多就是多选」那种推断）——猜错的后果是用户以为能多选、提交上去只剩一个。
   */
  multiSelect: boolean = false;

  /** 没有选项 ⇒ 只能填自由文本。 */
  isFreeText(): boolean {
    return this.options.length === 0;
  }

  static fromJson(map: JsonMap | null): ChatQuestion {
    const v: ChatQuestion = new ChatQuestion();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.question = JsonAccess.str(map, 'question') ?? '';
    v.header = JsonAccess.str(map, 'header');
    v.detail = JsonAccess.str(map, 'detail');
    const raw: JsonMap[] = JsonAccess.objArr(map, 'options');
    for (let i = 0; i < raw.length; i++) {
      v.options.push(QuestionOption.fromJson(raw[i]));
    }
    v.multiSelect = JsonAccess.bool(map, 'multiSelect') ?? false;
    return v;
  }
}

/**
 * 一次 `ask_user_question` 调用留下的一组待答问题。
 *
 * 只处理 `continued` 状态：`open` 是内核的前台阻塞态（Agent 正卡在那里等答案），
 * 远程客户端答不了；`continued` 才是「问题问出来了、Agent 已经继续跑、答复属于补交」。
 */
export class PendingQuestionSet {
  callId: string = '';
  state: string = '';
  questions: ChatQuestion[] = [];
  /**
   * 这道题是不是**正阻塞着** agent 前台等待（插件侧由 QuestionBridge 接管）。
   * `true`：作答会作为那次工具调用的返回值送回去；缺省 false：答复属于补交。
   * 带默认值是因为它由**插件新加**（老服务端不返回它）。
   */
  viaBridge: boolean = false;

  /** 是否属于「手机能补交」的那一类。 */
  isAnswerable(): boolean {
    return this.state === QUESTION_STATE_CONTINUED;
  }

  static fromJson(map: JsonMap | null): PendingQuestionSet {
    const v: PendingQuestionSet = new PendingQuestionSet();
    v.callId = JsonAccess.str(map, 'callId') ?? '';
    v.state = JsonAccess.str(map, 'state') ?? '';
    const raw: JsonMap[] = JsonAccess.objArr(map, 'questions');
    for (let i = 0; i < raw.length; i++) {
      v.questions.push(ChatQuestion.fromJson(raw[i]));
    }
    v.viaBridge = JsonAccess.bool(map, 'viaBridge') ?? false;
    return v;
  }
}

/** 一道题的答案。 */
export class QuestionAnswer {
  id: string = '';
  /** 选中的选项 label；没有选项的题填空数组。 */
  selected: string[] = [];
  /**
   * 自由文本答案。刻意用**非空默认值** `""`：编码时等于默认值就**不写 `custom` 键**，
   * 而不是发一个 `"custom": null` 让服务端去猜。
   */
  custom: string = '';

  static create(id: string, selected: string[], custom: string = ''): QuestionAnswer {
    const v: QuestionAnswer = new QuestionAnswer();
    v.id = id;
    v.selected = selected;
    v.custom = custom;
    return v;
  }

  toJsonString(): string {
    const names: string[] = [];
    for (let i = 0; i < this.selected.length; i++) {
      names.push(JSON.stringify(this.selected[i]));
    }
    let out: string = `{"id":${JSON.stringify(this.id)},"selected":`;
    out += encodeArrayOf(names);
    if (this.custom.length > 0) {
      out += `,"custom":${JSON.stringify(this.custom)}`;
    }
    return `${out}}`;
  }
}

export class QuestionAnswerRequest {
  answers: QuestionAnswer[] = [];

  constructor(answers: QuestionAnswer[] = []) {
    this.answers = answers;
  }

  toJsonString(): string {
    const fragments: string[] = [];
    for (let i = 0; i < this.answers.length; i++) {
      fragments.push(this.answers[i].toJsonString());
    }
    return `{"answers":${encodeArrayOf(fragments)}}`;
  }
}

// ---------------------------------------------------------------------------
// 命令 / 待办 / 权限选择（后两者由事件载荷解析）
// ---------------------------------------------------------------------------

export class CommandInput {
  hint: string = '';

  static fromJson(map: JsonMap | null): CommandInput {
    const v: CommandInput = new CommandInput();
    v.hint = JsonAccess.str(map, 'hint') ?? '';
    return v;
  }
}

export class CommandDescriptor {
  name: string = '';
  description: string = '';
  input: CommandInput | null = null;

  static fromJson(map: JsonMap | null): CommandDescriptor {
    const v: CommandDescriptor = new CommandDescriptor();
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.description = JsonAccess.str(map, 'description') ?? '';
    const input: JsonMap | null = JsonAccess.obj(map, 'input');
    v.input = input === null ? null : CommandInput.fromJson(input);
    return v;
  }
}

export class CommandResult {
  kind: string = '';
  text: string | null = null;
  sourceEventSeq: number | null = null;

  static fromJson(map: JsonMap | null): CommandResult {
    const v: CommandResult = new CommandResult();
    v.kind = JsonAccess.str(map, 'kind') ?? '';
    v.text = JsonAccess.str(map, 'text');
    v.sourceEventSeq = JsonAccess.num(map, 'sourceEventSeq');
    return v;
  }
}

export class CommandExecution {
  commandId: string = '';
  result: CommandResult = new CommandResult();

  static fromJson(map: JsonMap | null): CommandExecution {
    const v: CommandExecution = new CommandExecution();
    v.commandId = JsonAccess.str(map, 'commandId') ?? '';
    v.result = CommandResult.fromJson(JsonAccess.obj(map, 'result'));
    return v;
  }
}

export class TodoItem {
  content: string = '';
  status: string = '';

  static fromJson(map: JsonMap | null): TodoItem {
    const v: TodoItem = new TodoItem();
    v.content = JsonAccess.str(map, 'content') ?? '';
    v.status = JsonAccess.str(map, 'status') ?? '';
    return v;
  }
}

export class TodoItemList {
  static fromJsonArray(items: JsonMap[]): TodoItem[] {
    const out: TodoItem[] = [];
    for (let i = 0; i < items.length; i++) {
      out.push(TodoItem.fromJson(items[i]));
    }
    return out;
  }
}

export class PermissionOption {
  value: string = '';
  name: string = '';
  description: string | null = null;

  constructor(value: string = '', name: string = '', description: string | null = null) {
    this.value = value;
    this.name = name;
    this.description = description;
  }

  static fromJson(map: JsonMap | null): PermissionOption {
    const v: PermissionOption = new PermissionOption();
    v.value = JsonAccess.str(map, 'value') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.description = JsonAccess.str(map, 'description');
    return v;
  }
}

export class PermissionSelect {
  options: PermissionOption[] = [];
  currentValue: string = '';

  constructor(options: PermissionOption[] = [], currentValue: string = '') {
    this.options = options;
    this.currentValue = currentValue;
  }

  static fromJson(map: JsonMap | null): PermissionSelect {
    const v: PermissionSelect = new PermissionSelect();
    const raw: JsonMap[] = JsonAccess.objArr(map, 'options');
    for (let i = 0; i < raw.length; i++) {
      v.options.push(PermissionOption.fromJson(raw[i]));
    }
    v.currentValue = JsonAccess.str(map, 'currentValue') ?? '';
    return v;
  }
}

// ---------------------------------------------------------------------------
// 模型选择
// ---------------------------------------------------------------------------

export class ModelSelection {
  provider: string = '';
  model: string = '';
  reasoningEffort: string | null = null;

  constructor(provider: string = '', model: string = '', reasoningEffort: string | null = null) {
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
  }

  toJsonString(): string {
    return new WireBuilder()
      .put('provider', this.provider)
      .put('model', this.model)
      .put('reasoningEffort', this.reasoningEffort)
      .build();
  }

  static fromJson(map: JsonMap | null): ModelSelection {
    return new ModelSelection(
      JsonAccess.str(map, 'provider') ?? '',
      JsonAccess.str(map, 'model') ?? '',
      JsonAccess.str(map, 'reasoningEffort'),
    );
  }
}

export class ModelReasoningEffort {
  id: string = '';
  name: string = '';
  description: string | null = null;

  static fromJson(map: JsonMap | null): ModelReasoningEffort {
    const v: ModelReasoningEffort = new ModelReasoningEffort();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.description = JsonAccess.str(map, 'description');
    return v;
  }
}

export class ModelReasoning {
  efforts: ModelReasoningEffort[] = [];
  defaultEffort: string | null = null;

  static fromJson(map: JsonMap | null): ModelReasoning {
    const v: ModelReasoning = new ModelReasoning();
    const raw: JsonMap[] = JsonAccess.objArr(map, 'efforts');
    for (let i = 0; i < raw.length; i++) {
      v.efforts.push(ModelReasoningEffort.fromJson(raw[i]));
    }
    v.defaultEffort = JsonAccess.str(map, 'defaultEffort');
    return v;
  }
}

export class ModelView {
  id: string = '';
  name: string = '';
  description: string | null = null;
  contextWindow: number | null = null;
  maxTokens: number | null = null;
  reasoning: ModelReasoning | null = null;

  static fromJson(map: JsonMap | null): ModelView {
    const v: ModelView = new ModelView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.description = JsonAccess.str(map, 'description');
    v.contextWindow = JsonAccess.num(map, 'contextWindow');
    v.maxTokens = JsonAccess.num(map, 'maxTokens');
    const reasoning: JsonMap | null = JsonAccess.obj(map, 'reasoning');
    v.reasoning = reasoning === null ? null : ModelReasoning.fromJson(reasoning);
    return v;
  }
}

export class ModelProviderGroup {
  id: string = '';
  name: string = '';
  models: ModelView[] = [];

  static fromJson(map: JsonMap | null): ModelProviderGroup {
    const v: ModelProviderGroup = new ModelProviderGroup();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    const raw: JsonMap[] = JsonAccess.objArr(map, 'models');
    for (let i = 0; i < raw.length; i++) {
      v.models.push(ModelView.fromJson(raw[i]));
    }
    return v;
  }
}

export class ModelFailure {
  provider: string = '';
  message: string = '';

  static fromJson(map: JsonMap | null): ModelFailure {
    const v: ModelFailure = new ModelFailure();
    v.provider = JsonAccess.str(map, 'provider') ?? '';
    v.message = JsonAccess.str(map, 'message') ?? '';
    return v;
  }
}

export class SessionModels {
  current: ModelSelection = new ModelSelection();
  routable: boolean = false;
  groups: ModelProviderGroup[] = [];
  failures: ModelFailure[] = [];

  static fromJson(map: JsonMap | null): SessionModels {
    const v: SessionModels = new SessionModels();
    v.current = ModelSelection.fromJson(JsonAccess.obj(map, 'current'));
    v.routable = JsonAccess.bool(map, 'routable') ?? false;
    const rawGroups: JsonMap[] = JsonAccess.objArr(map, 'groups');
    for (let i = 0; i < rawGroups.length; i++) {
      v.groups.push(ModelProviderGroup.fromJson(rawGroups[i]));
    }
    const rawFailures: JsonMap[] = JsonAccess.objArr(map, 'failures');
    for (let i = 0; i < rawFailures.length; i++) {
      v.failures.push(ModelFailure.fromJson(rawFailures[i]));
    }
    return v;
  }
}

// ---------------------------------------------------------------------------
// 供应商设置
// ---------------------------------------------------------------------------

export class ProviderModel {
  id: string = '';
  name: string | null = null;
  contextWindow: number | null = null;
  maxTokens: number | null = null;

  /** JSON 映射（null 字段省略），供嵌进父请求体。 */
  toMap(): JsonMap {
    return new WireBuilder()
      .put('id', this.id)
      .put('name', this.name)
      .put('contextWindow', this.contextWindow)
      .put('maxTokens', this.maxTokens)
      .buildMap();
  }

  toJsonString(): string {
    return JSON.stringify(this.toMap());
  }

  static fromJson(map: JsonMap | null): ProviderModel {
    const v: ProviderModel = new ProviderModel();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name');
    v.contextWindow = JsonAccess.num(map, 'contextWindow');
    v.maxTokens = JsonAccess.num(map, 'maxTokens');
    return v;
  }
}

export class ProviderConfig {
  baseURL: string | null = null;
  api: string | null = null;
  displayName: string | null = null;
  thinking: string | null = null;
  reasoningEffort: string | null = null;
  models: ProviderModel[] = [];
  modelsInherited: boolean = false;

  static fromJson(map: JsonMap | null): ProviderConfig {
    const v: ProviderConfig = new ProviderConfig();
    v.baseURL = JsonAccess.str(map, 'baseURL');
    v.api = JsonAccess.str(map, 'api');
    v.displayName = JsonAccess.str(map, 'displayName');
    v.thinking = JsonAccess.str(map, 'thinking');
    v.reasoningEffort = JsonAccess.str(map, 'reasoningEffort');
    const raw: JsonMap[] = JsonAccess.objArr(map, 'models');
    for (let i = 0; i < raw.length; i++) {
      v.models.push(ProviderModel.fromJson(raw[i]));
    }
    v.modelsInherited = JsonAccess.bool(map, 'modelsInherited') ?? false;
    return v;
  }
}

export class CredentialState {
  ref: string = '';
  configured: boolean = false;
  source: string | null = null;
  writable: boolean = false;

  static fromJson(map: JsonMap | null): CredentialState {
    const v: CredentialState = new CredentialState();
    v.ref = JsonAccess.str(map, 'ref') ?? '';
    v.configured = JsonAccess.bool(map, 'configured') ?? false;
    v.source = JsonAccess.str(map, 'source');
    v.writable = JsonAccess.bool(map, 'writable') ?? false;
    return v;
  }
}

export class ProviderView {
  id: string = '';
  displayName: string = '';
  active: boolean = false;
  declared: boolean | null = null;
  configurable: boolean = false;
  configured: boolean = false;
  removable: boolean = false;
  credential: CredentialState = new CredentialState();
  config: ProviderConfig = new ProviderConfig();

  static fromJson(map: JsonMap | null): ProviderView {
    const v: ProviderView = new ProviderView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.displayName = JsonAccess.str(map, 'displayName') ?? '';
    v.active = JsonAccess.bool(map, 'active') ?? false;
    v.declared = JsonAccess.bool(map, 'declared');
    v.configurable = JsonAccess.bool(map, 'configurable') ?? false;
    v.configured = JsonAccess.bool(map, 'configured') ?? false;
    v.removable = JsonAccess.bool(map, 'removable') ?? false;
    v.credential = CredentialState.fromJson(JsonAccess.obj(map, 'credential'));
    v.config = ProviderConfig.fromJson(JsonAccess.obj(map, 'config'));
    return v;
  }
}

export class CustomProviderCapability {
  available: boolean = false;
  protocols: string[] = [];
  revision: number | null = null;

  static fromJson(map: JsonMap | null): CustomProviderCapability {
    const v: CustomProviderCapability = new CustomProviderCapability();
    v.available = JsonAccess.bool(map, 'available') ?? false;
    v.protocols = JsonAccess.strArr(map, 'protocols');
    v.revision = JsonAccess.num(map, 'revision');
    return v;
  }
}

export class ProviderSettings {
  writable: boolean = false;
  /** 命名空间 → 修订号。JSON 是普通对象，这里收敛成 Map 便于取值。 */
  revisionByNamespace: Map<string, number> = new Map();
  customProvider: CustomProviderCapability = new CustomProviderCapability();
  providers: ProviderView[] = [];

  revision(namespace: string): number | null {
    const v: number | undefined = this.revisionByNamespace.get(namespace);
    return v === undefined ? null : v;
  }

  static fromJson(map: JsonMap | null): ProviderSettings {
    const v: ProviderSettings = new ProviderSettings();
    v.writable = JsonAccess.bool(map, 'writable') ?? false;
    const revisions: JsonMap | null = JsonAccess.obj(map, 'revisionByNamespace');
    if (revisions !== null) {
      const keys: string[] = Object.keys(revisions);
      for (let i = 0; i < keys.length; i++) {
        const key: string = keys[i];
        const num: number | null = JsonAccess.num(revisions, key);
        if (num !== null) {
          v.revisionByNamespace.set(key, num);
        }
      }
    }
    v.customProvider = CustomProviderCapability.fromJson(JsonAccess.obj(map, 'customProvider'));
    const raw: JsonMap[] = JsonAccess.objArr(map, 'providers');
    for (let i = 0; i < raw.length; i++) {
      v.providers.push(ProviderView.fromJson(raw[i]));
    }
    return v;
  }
}

/** `PATCH settings/providers/{id}` 请求体：未指定的字段**不出现**（不是发 null）。 */
export class ProviderPatch {
  displayName: string | null = null;
  baseURL: string | null = null;
  api: string | null = null;
  apiKey: string | null = null;
  thinking: string | null = null;
  reasoningEffort: string | null = null;
  models: ProviderModel[] | null = null;
  expectedRevision: number | null = null;

  toJsonString(): string {
    const b: WireBuilder = new WireBuilder()
      .put('displayName', this.displayName)
      .put('baseURL', this.baseURL)
      .put('api', this.api)
      .put('apiKey', this.apiKey)
      .put('thinking', this.thinking)
      .put('reasoningEffort', this.reasoningEffort)
      .put('expectedRevision', this.expectedRevision);
    if (this.models !== null) {
      const maps: JsonMapArray = [];
      for (let i = 0; i < this.models.length; i++) {
        maps.push(this.models[i].toMap());
      }
      b.put('models', maps);
    }
    return b.build();
  }
}

/** `POST settings/providers` 请求体：自定义供应商。 */
export class CustomProviderCreate {
  id: string = '';
  displayName: string | null = null;
  baseURL: string = '';
  api: string = '';
  apiKey: string | null = null;
  models: ProviderModel[] = [];
  expectedRevision: number | null = null;

  toJsonString(): string {
    const maps: JsonMapArray = [];
    for (let i = 0; i < this.models.length; i++) {
      maps.push(this.models[i].toMap());
    }
    return new WireBuilder()
      .put('id', this.id)
      .put('displayName', this.displayName)
      .put('baseURL', this.baseURL)
      .put('api', this.api)
      .put('apiKey', this.apiKey)
      .put('expectedRevision', this.expectedRevision)
      .put('models', maps)
      .build();
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

/**
 * 已安装插件清单里的一条记录。字段全带默认值，理由同 `AgentPreset.trust` 那次事故。
 *
 * `state` 取服务端约定的四种值：`loaded` / `installed-not-loaded` / `declared-missing` /
 * `runtime-provided`（官方包随 DSH 运行时自带，属正常状态）；未知取值由 UI 兜底显示。
 */
export class PluginEntry {
  name: string = '';
  /** package.json 里的版本声明，如 `^0.4.5`；可能为 null。 */
  declared: string | null = null;
  /** node_modules 里实际装上的版本；可能为 null。 */
  installed: string | null = null;
  loaded: boolean = false;
  /** 是否 DSH 官方包（`@deepseek-ai/` 前缀）。 */
  official: boolean = false;
  state: string = '';
  description: string | null = null;
  /** 包的主页 / 仓库地址（服务器已剥掉 `git+` 与 `.git`）。 */
  homepage: string | null = null;
  /**
   * 有没有新版本可装。**三态，别当布尔用**：`null` 表示「没查 / 查不到」，
   * 与 `false`（「已是最新」）不是一回事 —— 不查的时候把 null 显示成「已是最新」就是撒谎。
   */
  updateAvailable: boolean | null = null;
  /** npm 上的最新版本号；没查或查不到时为 null。 */
  latestVersion: string | null = null;
  /**
   * 能否在 App 里启停。官方包与没装进 profile 的包都为 false —— 界面对它们不该画开关：
   * 画了就是骗用户去点一个必然失败的按钮。
   */
  toggleable: boolean = false;

  static fromJson(map: JsonMap | null): PluginEntry {
    const v: PluginEntry = new PluginEntry();
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.declared = JsonAccess.str(map, 'declared');
    v.installed = JsonAccess.str(map, 'installed');
    v.loaded = JsonAccess.bool(map, 'loaded') ?? false;
    v.official = JsonAccess.bool(map, 'official') ?? false;
    v.state = JsonAccess.str(map, 'state') ?? '';
    v.description = JsonAccess.str(map, 'description');
    v.homepage = JsonAccess.str(map, 'homepage');
    v.updateAvailable = JsonAccess.bool(map, 'updateAvailable');
    v.latestVersion = JsonAccess.str(map, 'latestVersion');
    v.toggleable = JsonAccess.bool(map, 'toggleable') ?? false;
    return v;
  }
}

/**
 * `PATCH settings/plugins` 的响应。
 *
 * `restartRequired` 目前**恒为 true**：服务端改写的是 profile 的 `dsh.profile.bundles`，
 * 而那份清单**只在 DSH 启动时读一次** —— 运行中的进程仍旧用着旧集合。界面必须把这句话
 * 明说，否则用户点完开关看到插件照旧在跑，只会以为「这个功能是坏的」。
 */
export class PluginToggleResult {
  name: string = '';
  loaded: boolean = false;
  /** 改动前写的备份文件名（幂等时为空串）。 */
  backupName: string = '';
  /** 改动后 bundles 数组的长度，便于界面显示「17 → 18」。 */
  bundleCount: number = 0;
  restartRequired: boolean = true;

  static fromJson(map: JsonMap | null): PluginToggleResult {
    const v: PluginToggleResult = new PluginToggleResult();
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.loaded = JsonAccess.bool(map, 'loaded') ?? false;
    v.backupName = JsonAccess.str(map, 'backupName') ?? '';
    v.bundleCount = JsonAccess.num(map, 'bundleCount') ?? 0;
    v.restartRequired = JsonAccess.bool(map, 'restartRequired') ?? true;
    return v;
  }
}

/** `PATCH settings/plugins` 的请求体。 */
export class PluginToggleRequest {
  name: string = '';
  loaded: boolean = false;

  constructor(name: string = '', loaded: boolean = false) {
    this.name = name;
    this.loaded = loaded;
  }

  toJsonString(): string {
    return new WireBuilder().put('name', this.name).put('loaded', this.loaded).build();
  }
}

/**
 * `GET settings/plugins` 的响应。
 *
 * `available` 为 false 时 `items` 为空，`reason` 给出人可读的失败原因
 * （`PROFILE_UNKNOWN` / `MANIFEST_UNREADABLE`），界面必须显示解释而不是空白。
 *
 * `profile` 与 `profilePath` 在服务端是 `string | null`（判定不出时会**显式发送 null**），
 * 所以必须声明为可空。
 */
export class PluginInventory {
  profile: string | null = null;
  profilePath: string | null = null;
  available: boolean = false;
  reason: string | null = null;
  loadedCount: number = 0;
  problemCount: number = 0;
  items: PluginEntry[] = [];

  static fromJson(map: JsonMap | null): PluginInventory {
    const v: PluginInventory = new PluginInventory();
    v.profile = JsonAccess.str(map, 'profile');
    v.profilePath = JsonAccess.str(map, 'profilePath');
    v.available = JsonAccess.bool(map, 'available') ?? false;
    v.reason = JsonAccess.str(map, 'reason');
    v.loadedCount = JsonAccess.num(map, 'loadedCount') ?? 0;
    v.problemCount = JsonAccess.num(map, 'problemCount') ?? 0;
    const raw: JsonMap[] = JsonAccess.objArr(map, 'items');
    for (let i = 0; i < raw.length; i++) {
      v.items.push(PluginEntry.fromJson(raw[i]));
    }
    return v;
  }
}

// ---------------------------------------------------------------------------
// 消息内容（PromptContentPart 联合）
// ---------------------------------------------------------------------------

/**
 * 一条 prompt 内容 —— DSH 内核的 `PromptContentPart` 联合类型。
 *
 * 三种形态（与内核逐字段对齐，多一个字段就可能让服务端的 union 解析失败）：
 * - `text`：纯文本；
 * - `image`：图片，**base64 直接内联**，一步到位，不需要先上传；
 * - `file`：文件，先经 `chat/sessions/:id/attachments` 换来 `receiptId`，再引用。
 *
 * 判别器是 `type`，序列化结果就是内核要的形状：
 * `{"type":"image","mediaType":"image/png","data":"..."}`。
 * 这里用「单一扁平类 + type 分派」而不是三个子类：编码结果完全一致，且避开 ArkTS 的继承覆盖语法歧义。
 */
export class PromptPart {
  static readonly TYPE_TEXT: string = 'text';
  static readonly TYPE_IMAGE: string = 'image';
  static readonly TYPE_FILE: string = 'file';

  type: string = PromptPart.TYPE_TEXT;
  /** text 形态的正文。 */
  text: string = '';
  /** image 形态：如 `image/png`，内核按它决定怎么解码 `data`。 */
  mediaType: string = 'image/png';
  /** image 形态：标准 base64（非 URL-safe）。 */
  data: string = '';
  /** image 形态：可选原文件名，仅用于展示；为 null 时不发送该键。 */
  name: string | null = null;
  /** file 形态：上传换来的回执 id。 */
  receiptId: string = '';

  static text(text: string): PromptPart {
    const p: PromptPart = new PromptPart();
    p.type = PromptPart.TYPE_TEXT;
    p.text = text;
    return p;
  }

  static image(mediaType: string, data: string, name: string | null = null): PromptPart {
    const p: PromptPart = new PromptPart();
    p.type = PromptPart.TYPE_IMAGE;
    p.mediaType = mediaType;
    p.data = data;
    p.name = name;
    return p;
  }

  static file(receiptId: string): PromptPart {
    const p: PromptPart = new PromptPart();
    p.type = PromptPart.TYPE_FILE;
    p.receiptId = receiptId;
    return p;
  }

  static fromJson(map: JsonMap | null): PromptPart | null {
    const t: string | null = JsonAccess.str(map, 'type');
    if (t === PromptPart.TYPE_IMAGE) {
      return PromptPart.image(
        JsonAccess.str(map, 'mediaType') ?? 'image/png',
        JsonAccess.str(map, 'data') ?? '',
        JsonAccess.str(map, 'name'),
      );
    }
    if (t === PromptPart.TYPE_FILE) {
      return PromptPart.file(JsonAccess.str(map, 'receiptId') ?? '');
    }
    if (t === PromptPart.TYPE_TEXT) {
      return PromptPart.text(JsonAccess.str(map, 'text') ?? '');
    }
    return null;
  }

  /** 按 type **只写该形态的字段**，绝不夹带其它形态的键。 */
  toMap(): JsonMap {
    if (this.type === PromptPart.TYPE_IMAGE) {
      return new WireBuilder()
        .put('type', PromptPart.TYPE_IMAGE)
        .put('mediaType', this.mediaType)
        .put('data', this.data)
        .put('name', this.name)
        .buildMap();
    }
    if (this.type === PromptPart.TYPE_FILE) {
      return new WireBuilder()
        .put('type', PromptPart.TYPE_FILE)
        .put('receiptId', this.receiptId)
        .buildMap();
    }
    return new WireBuilder()
      .put('type', PromptPart.TYPE_TEXT)
      .put('text', this.text)
      .buildMap();
  }

  toJsonString(): string {
    return JSON.stringify(this.toMap());
  }

  /** 映射数组：嵌进消息体 `content` 时用它（别用已序列化字符串）。 */
  static toMapArray(parts: PromptPart[]): JsonMapArray {
    const maps: JsonMapArray = [];
    for (let i = 0; i < parts.length; i++) {
      maps.push(parts[i].toMap());
    }
    return maps;
  }

  /** 编码整组 part；空数组返回 `[]`。 */
  static encodeArray(parts: PromptPart[]): string {
    return JSON.stringify(PromptPart.toMapArray(parts));
  }
}

/** 保留任务书里的名字（与 `PromptPart` 是同一个类型）。 */
export type PromptContentPart = PromptPart;

/**
 * `POST chat/sessions/:id/attachments` 的响应。字段全带默认值：服务端将来省略 `name`
 * （或返回 null）时，不能让整个上传流程因为一个可选字段就解码失败。
 */
export class UploadedAttachment {
  receiptId: string = '';
  name: string = '';

  static fromJson(map: JsonMap | null): UploadedAttachment {
    const v: UploadedAttachment = new UploadedAttachment();
    v.receiptId = JsonAccess.str(map, 'receiptId') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    return v;
  }
}

// ---------------------------------------------------------------------------
// 会话事件 / 历史 / 工作区事件
// ---------------------------------------------------------------------------

/** 事件载荷 / 投影 / surfaceOp 都是「自由形态的 JSON」，这里统一用 `Object | null` 承载。 */
export class SessionEvent {
  type: string = '';
  seq: number = 0;
  time: number = 0;
  data: Object | null = null;
  sourceEventSeqs: number[] = [];
  surfaceOp: Object | null = null;

  static fromJson(map: JsonMap | null): SessionEvent {
    const v: SessionEvent = new SessionEvent();
    v.type = JsonAccess.str(map, 'type') ?? '';
    v.seq = JsonAccess.num(map, 'seq') ?? 0;
    v.time = JsonAccess.num(map, 'time') ?? 0;
    v.data = JsonAccess.raw(map, 'data');
    const rawSeqs: Object[] = JsonAccess.arr(map, 'sourceEventSeqs');
    for (let i = 0; i < rawSeqs.length; i++) {
      const n: Object = rawSeqs[i];
      if (typeof n === 'number') {
        v.sourceEventSeqs.push(n as number);
      }
    }
    v.surfaceOp = JsonAccess.raw(map, 'surfaceOp');
    return v;
  }

  /** 事件载荷对象（非对象载荷返回 null）；供上层零散取值。 */
  dataMap(): JsonMap | null {
    return JsonAccess.asMap(this.data);
  }
}

export class HistoryEntry {
  event: SessionEvent = new SessionEvent();
  /** 已渲染过的视图（服务端可给，也可不给）。 */
  view: Object | null = null;

  static fromJson(map: JsonMap | null): HistoryEntry {
    const v: HistoryEntry = new HistoryEntry();
    v.event = SessionEvent.fromJson(JsonAccess.obj(map, 'event'));
    v.view = JsonAccess.raw(map, 'view');
    return v;
  }
}

export class ChatHistory {
  events: HistoryEntry[] = [];
  hasMore: boolean = false;
  projections: Object | null = null;

  /**
   * 往前补一页之后的副本。
   *
   * 为 `HarnessViewModel.loadOlderHistory` 补：对应 Kotlin
   * `current.copy(events = 合并去重后的, hasMore = older.hasMore, projections = ...)` ——
   * `hasMore` **必须取新拉回来那一页的值**（旧值说的是「还能不能往前翻」，
   * 合并之后这个问题的答案只由更老的那一页决定）。
   */
  withOlder(events: HistoryEntry[], hasMore: boolean, projections: Object | null): ChatHistory {
    const v: ChatHistory = new ChatHistory();
    v.events = events;
    v.hasMore = hasMore;
    v.projections = projections;
    return v;
  }

  static fromJson(map: JsonMap | null): ChatHistory {
    const v: ChatHistory = new ChatHistory();
    const raw: JsonMap[] = JsonAccess.objArr(map, 'events');
    for (let i = 0; i < raw.length; i++) {
      v.events.push(HistoryEntry.fromJson(raw[i]));
    }
    v.hasMore = JsonAccess.bool(map, 'hasMore') ?? false;
    v.projections = JsonAccess.raw(map, 'projections');
    return v;
  }
}

/** WebSocket `events` 推送的一帧。 */
export class WorkspaceEvent {
  id: string = '';
  type: string = '';
  time: number = 0;
  data: Object | null = null;

  static fromJson(map: JsonMap | null): WorkspaceEvent {
    const v: WorkspaceEvent = new WorkspaceEvent();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.type = JsonAccess.str(map, 'type') ?? '';
    v.time = JsonAccess.num(map, 'time') ?? 0;
    v.data = JsonAccess.raw(map, 'data');
    return v;
  }

  static fromJsonText(text: string): WorkspaceEvent | null {
    const map: JsonMap | null = JsonAccess.asMap(JsonAccess.parse(text));
    return map === null ? null : WorkspaceEvent.fromJson(map);
  }

  dataMap(): JsonMap | null {
    return JsonAccess.asMap(this.data);
  }
}

/**
 * 事件载荷里的字符串字段。
 *
 * 对应原工程那两个扩展函数 `WorkspaceEvent.dataString` —— 取值口径是
 * `JsonPrimitive.contentOrNull`：字符串原样返回，**数字 / 布尔转成文本**（服务端偶尔把
 * `sessionId` 发成数字，照搬 `JsonAccess.str` 会静默丢掉这一帧），其余形态（对象、数组、null）
 * 一律返回 null。
 *
 * 与 `ChatPresentation` 里那份取值助手同口径，但那个只在模块内可见，
 * 所以在这里补一对导出的，供 HarnessViewModel 与单测直接用。
 */
export function eventDataString(event: WorkspaceEvent, key: string): string | null {
  const value: Object | null = JsonAccess.raw(event.dataMap(), key);
  if (typeof value === 'string') {
    return value as string;
  }
  if (typeof value === 'number') {
    return `${value as number}`;
  }
  if (typeof value === 'boolean') {
    return (value as boolean) ? 'true' : 'false';
  }
  return null;
}

/**
 * 事件载荷里的整数字段。
 *
 * 对应 `WorkspaceEvent.dataInt`（`JsonPrimitive.intOrNull`）：数字型只认整数
 * （`turn` / `step` / `seq` 都是整数，小数不是这个协议里出现过的形态），
 * 字符串型按 Kotlin `toIntOrNull` 的口径严格解析 —— `"3"` → 3，
 * **`" 3"`、`"3.5"`、`"0x3"`、`""` 一律 null**（Kotlin 不接受前后空白，也不接受其它进制）。
 */
export function eventDataInt(event: WorkspaceEvent, key: string): number | null {
  const value: Object | null = JsonAccess.raw(event.dataMap(), key);
  if (typeof value === 'number') {
    const n: number = value as number;
    return Number.isInteger(n) ? n : null;
  }
  if (typeof value === 'string') {
    return parseStrictInt(value as string);
  }
  return null;
}

/** 严格十进制解析（不接受空白、小数点、进制前缀），失败返回 null。 */
function parseStrictInt(raw: string): number | null {
  let index: number = 0;
  let negative: boolean = false;
  if (raw.length > 0 && (raw.charAt(0) === '-' || raw.charAt(0) === '+')) {
    negative = raw.charAt(0) === '-';
    index = 1;
  }
  if (index >= raw.length) {
    return null;
  }
  let acc: number = 0;
  while (index < raw.length) {
    const code: number = raw.charCodeAt(index);
    if (code < 48 || code > 57) {
      return null;
    }
    acc = acc * 10 + (code - 48);
    index++;
  }
  return negative ? -acc : acc;
}

// ---------------------------------------------------------------------------
// 旧版单连接存储
// ---------------------------------------------------------------------------

export class StoredConnection {
  endpoint: string = '';
  token: string = '';

  constructor(endpoint: string = '', token: string = '') {
    this.endpoint = endpoint;
    this.token = token;
  }

  isUsable(): boolean {
    return this.endpoint.trim().length > 0;
  }

  static fromJson(map: JsonMap | null): StoredConnection {
    return new StoredConnection(
      JsonAccess.str(map, 'endpoint') ?? '',
      JsonAccess.str(map, 'token') ?? '',
    );
  }
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 非 2xx 且响应体 `{error:{code,message,requestId?}}` 可解析时抛出的异常。 */
export class DshApiException extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
