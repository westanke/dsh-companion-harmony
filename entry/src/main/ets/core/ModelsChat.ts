/**
 * 线上模型 —— **会话域**：会话本体、工作区、Agent 预设、审批、问答（`ask_user_question`）、
 * 命令、待办、权限选择。
 *
 * 面向服务端线上模型的**三条规矩**（字段一律给默认值 / 请求体省略 null / 判别联合按 type 分派）
 * 写在 `Models.ts` 的文件头 —— 那是本模块的索引。拆分的来龙去脉也见那里。
 */

import { JsonAccess, JsonMap } from './JsonAccess';
import { encodeArrayOf } from './ModelsWire';

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

