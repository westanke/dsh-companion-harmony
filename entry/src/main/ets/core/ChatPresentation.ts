/**
 * 聊天页的**呈现模型** —— 移植自原工程 `data/ChatPresentation.kt`（825 行）。
 *
 * 这个文件是「服务端事件 → 界面能看到的一行行东西」之间唯一的接缝：
 * 聊天页（`ChatScreen`）不直接读事件，只读这里吐出来的 `ChatDisplayItem[]`。
 * 所以移植聊天页之前，这份逻辑必须先落地并被单测钉住。
 *
 * ## 三条贯穿全文件的取向
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
 *   `toBooleanStrictOrNull` 复刻（见 [ChatJson]），而不是直接用 JS 的宽松转换。
 */

import { isBlank, isNotBlank, isKotlinWhitespace, trimText } from './TextPredicates';
import { JsonAccess, JsonMap } from './JsonAccess';
import {
  ChatHistory, HistoryEntry, PermissionOption, PermissionSelect, SessionEvent, TodoItem, WorkspaceEvent,
} from './Models';

/** 实时行的 seq 占位：Kotlin 用 `Int.MAX_VALUE`，保证它们排在历史之后。 */
const LIVE_SEQ: number = 2147483647;

/** 交接说明里给机器读的那一行的标记；靠它把该行从正文里摘掉。 */
const HANDOFF_SOURCE_MARKER: string = '[Image: source: ';

/** 交接说明里给人看的那一行的开头（`🖼️ 图片 1「shot.jpg」（…）`）。 */
const HANDOFF_PREAMBLE_MARKER: string = '🖼️ 图片 ';

/**
 * 交接附件的 id 前缀：ViewModel / 界面靠它认出「这个 id 是一条文件路径，不是附件哈希」。
 */
export const HANDOFF_ATTACHMENT_PREFIX: string = 'handoff:';

/** `[Image: source: /abs/path.jpg]`；路径取到本行最后一个 `]`（路径里可能带空格）。 */
const HANDOFF_SOURCE_PATTERN: RegExp = /\[Image: source:\s*(.+)]/g;

export enum ChatItemKind {
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
  REASONING = 'REASONING',
  CONTEXT = 'CONTEXT',
  TOOL = 'TOOL',
  FAILURE = 'FAILURE',
}

/**
 * 一轮模型运行的**终局失败**（限流 429、配额用尽、密钥无效、登出停止…）。
 *
 * 与服务端 `chat.turn.failed` 帧的 `data.failure` 一一对应。所有字段都有默认值：
 * 这是从事件里解出来的结构，而服务端的 `code` 可能是空串（免费额度限流就是），
 * 所以 [code] 必须**可区分「空串」与「没有」** —— 客户端显示错误码那一位时，
 * 空串也应该原样显示，不能当成缺失。
 *
 * [stopped] 为 true 表示这不是模型故障，而是「退出登录导致任务停止」。
 */
export class ChatTurnFailure {
  message: string;
  /** null = 服务端没给 code；空串 = 服务端给了但为空（必须原样显示）。 */
  code: string | null;
  stopped: boolean;

  constructor(message: string = '', code: string | null = null, stopped: boolean = false) {
    this.message = message;
    this.code = code;
    this.stopped = stopped;
  }

  /**
   * 给人看的一行标题 —— 用**资源 key** 表达，具体语言交给界面。
   *
   * 这里以前直接写死中文（「任务已停止」/「本轮运行失败」），于是英文界面下也弹中文。
   * 纯逻辑层不碰资源系统，所以只给 key，渲染时再取字符串。
   */
  get titleKey(): string {
    return this.stopped ? 'turn_stopped_title' : 'turn_failed_title';
  }
}

/**
 * 会话历史里的一个图片附件。
 *
 * 注意这里**只有引用没有字节**：消息发送时图片是 base64 内联的，但存进历史后就变成
 * `{type:'image', attachment:{attachmentId:'sha256:…', …}}` —— 字节在服务端的附件存储里。
 * 所以显示一张历史图片需要第二步：拿 [attachmentId] 去 `attachments/{id}` 取字节。
 *
 * 所有字段都有默认值：这是从服务端事件里解出来的结构，缺字段比多字段常见得多。
 */
export class ChatAttachment {
  attachmentId: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
  name: string | null;
  /**
   * 纯文本模型发图时的**交接文件路径**（服务器绝对路径），非交接图是 null。
   *
   * 为什么单独一个字段：这类图**不在附件存储里**（那只存会话里的原生 image 部件），
   * 它是插件落在会话工作目录 `.dsh-images/` 下的普通文件。所以取字节不能走
   * `readAttachment`，要走「路径 → 授权根」的官方解析（`resolvePath` + 读文件）——
   * 那条路客户端早就有了，正是「已接入的图片显示方法」。
   */
  handoffPath: string | null;

  constructor(attachmentId: string = '', mediaType: string = '', width: number = 0, height: number = 0,
    bytes: number = 0, name: string | null = null, handoffPath: string | null = null) {
    this.attachmentId = attachmentId;
    this.mediaType = mediaType;
    this.width = width;
    this.height = height;
    this.bytes = bytes;
    this.name = name;
    this.handoffPath = handoffPath;
  }
}

/**
 * 一次工具调用的完整明细 —— 详情视图要渲染的东西都在这儿。
 *
 * 字段全部对着**真实会话日志**（105 份 `session.v4.jsonl.zstd`，共 19050 条 tool/result）：
 * - `tool/call` 的 data：`turn`/`step`/`callId`/`name`/`arguments`；`arguments` 是**字符串**
 *   （12471/12471 都能 JSON.parse），所以要格式化后再显示。
 * - `tool/result` 的 data.message：`role`/`source`/`toolCallId`/`content`/`isError`/`id`，
 *   六个 key 19050/19050 全在；`content` **一定是数组**（19050/19050），元素只有
 *   `text`（19050）与 `image`（73）两种；`isError` 为 true 的 689 条。
 * - 关联字段用 `message.toolCallId`（与 `message.source.callId` 实测完全相等：8006/8006）。
 */
export class ToolCallDetail {
  callId: string;
  name: string;
  /**
   * 内核给的原始 arguments（JSON 字符串，未格式化）。空串 = 这个工具没有参数。
   *
   * 字段名不能叫 `arguments`：JS 严格模式禁用该标识符，ArkTS 编译直接报
   * 「Binding arguments in strict mode」。语义不变，只是换了个名字。
   */
  argumentsJson: string;
  /** 结果正文；`null` = 还没有 `tool/result`（例如仍在运行）。空串是合法的「有结果但没文字」。 */
  result: string | null;
  /**
   * 内核 `message.isError`。
   *
   * 注意它**不等于**「命令没报错」：实测样本里 `curl` 超时、输出全是 stderr 的那条
   * `isError` 仍是 false。它只是内核自己标记的工具级失败。
   */
  failed: boolean;
  /** `result.time - call.time`（毫秒）。配不上、或时钟倒退时是 `null`，界面直接不显示这一行。 */
  durationMs: number | null;

  constructor(callId: string = '', name: string = '', argumentsJson: string = '', result: string | null = null,
    failed: boolean = false, durationMs: number | null = null) {
    this.callId = callId;
    this.name = name;
    this.argumentsJson = argumentsJson;
    this.result = result;
    this.failed = failed;
    this.durationMs = durationMs;
  }
}

export class ChatDisplayItem {
  id: string;
  seq: number;
  kind: ChatItemKind;
  title: string | null;
  body: string;
  streaming: boolean;
  /** 这条消息附带的图片；只发图不发字的消息正是靠它才不会被丢掉。 */
  attachments: ChatAttachment[];
  /**
   * 工具调用的动作短语，如 `['运行了代码', '修改了文件']`。
   *
   * 单独放一个字段而不是揉进 [title]：连续的多个工具调用要**合并成一行**，
   * 合并就是把各条的短语按首次出现顺序去重求并集。揉成字符串就得再拆开，
   * 那是在用分隔符当数据结构。
   */
  actions: string[];
  /**
   * 工具调用的**逐条明细**（输入 / 输出 / 成败 / 耗时）。
   *
   * 为什么是列表：连续的多次调用会被 [mergeToolRuns] 合并成一行，而详情视图要求
   * **每条都能单独展开** —— 只留第一条就等于把其余调用的输出全丢了。
   */
  tools: ToolCallDetail[];
  /**
   * 这一项是不是一轮的**终局失败**（限流 / 配额 / 密钥 / 登出停止）。
   *
   * 为什么单独一个字段而不是塞进 [body]：失败行有自己的一套版式（标题 + 正文 +
   * 错误码），而 [body] 在所有渲染器里都是「一段 Markdown 正文」。
   */
  failure: ChatTurnFailure | null;

  constructor(id: string, seq: number, kind: ChatItemKind, title: string | null = null, body: string = '',
    streaming: boolean = false, attachments: ChatAttachment[] = [], actions: string[] = [],
    tools: ToolCallDetail[] = [], failure: ChatTurnFailure | null = null) {
    this.id = id;
    this.seq = seq;
    this.kind = kind;
    this.title = title;
    this.body = body;
    this.streaming = streaming;
    this.attachments = attachments;
    this.actions = actions;
    this.tools = tools;
    this.failure = failure;
  }

  /**
   * 派生一份「只改这几个字段」的副本（对应 Kotlin 的 `copy`）。
   *
   * 只给合并工具行用，所以只暴露那几个真正会被改的字段，不做通用的 copy 机。
   */
  withMerged(id: string, title: string, body: string, actions: string[], tools: ToolCallDetail[]): ChatDisplayItem {
    return new ChatDisplayItem(id, this.seq, this.kind, title, body, this.streaming,
      this.attachments, actions, tools, this.failure);
  }
}

export class ChatDelta {
  sessionId: string;
  turn: number;
  step: number;
  index: number;
  kind: ChatItemKind;
  text: string;

  constructor(sessionId: string, turn: number, step: number, index: number, kind: ChatItemKind, text: string) {
    this.sessionId = sessionId;
    this.turn = turn;
    this.step = step;
    this.index = index;
    this.kind = kind;
    this.text = text;
  }
}

export class LiveChatBlock {
  index: number;
  kind: ChatItemKind;
  text: string;

  constructor(index: number, kind: ChatItemKind, text: string) {
    this.index = index;
    this.kind = kind;
    this.text = text;
  }
}

/**
 * 流式状态：**只装当前这一段（turn+step）**。
 *
 * 「turn/step 一变就整个换掉 base」是刻意的 —— 上一轮/上一段的内容由 REST 历史补回来，
 * 两边都留着就成了重复显示。
 *
 * 但这条约定有个前提：**历史真的会被推回页面**。那个前提长期不成立（WebView 页里一处
 * 早退判据写反了，逢「实时状态刚被置空」就 return），于是重置清掉的那部分没有任何东西
 * 补回来 —— 真机上就是「一直在同一个位置说这一段，就把上一段没了」。
 */
export class LiveChatState {
  sessionId: string;
  turn: number;
  step: number;
  blocks: LiveChatBlock[];
  revision: number;

  constructor(sessionId: string, turn: number, step: number, blocks: LiveChatBlock[] = [], revision: number = 0) {
    this.sessionId = sessionId;
    this.turn = turn;
    this.step = step;
    this.blocks = blocks;
    this.revision = revision;
  }

  append(delta: ChatDelta): LiveChatState {
    const sameScope: boolean =
      this.sessionId === delta.sessionId && this.turn === delta.turn && this.step === delta.step;
    const base: LiveChatState = sameScope ? this : new LiveChatState(delta.sessionId, delta.turn, delta.step);

    let existing: number = -1;
    for (let i = 0; i < base.blocks.length; i++) {
      if (base.blocks[i].index === delta.index) {
        existing = i;
        break;
      }
    }

    const next: LiveChatBlock[] = [];
    if (existing < 0) {
      for (let i = 0; i < base.blocks.length; i++) {
        next.push(base.blocks[i]);
      }
      next.push(new LiveChatBlock(delta.index, delta.kind, delta.text));
    } else {
      for (let i = 0; i < base.blocks.length; i++) {
        const previous: LiveChatBlock = base.blocks[i];
        if (i !== existing) {
          next.push(previous);
          continue;
        }
        // 同一 index 但 kind 变了：整段换掉，不拼接（拼接会把两种语义粘成一句）。
        const text: string = previous.kind === delta.kind ? previous.text + delta.text : delta.text;
        next.push(new LiveChatBlock(delta.index, delta.kind, text));
      }
    }
    next.sort((a: LiveChatBlock, b: LiveChatBlock): number => a.index - b.index);
    return new LiveChatState(base.sessionId, base.turn, base.step, next, base.revision + 1);
  }

  displayItems(): ChatDisplayItem[] {
    const out: ChatDisplayItem[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const block: LiveChatBlock = this.blocks[i];
      // 注意是 isNotEmpty（不是 isNotBlank）：只含空白的增量块也算「有内容」，照旧显示。
      if (block.text.length === 0) {
        continue;
      }
      out.push(new ChatDisplayItem(
        `live-${this.turn}-${this.step}-${block.index}-${block.kind}`,
        LIVE_SEQ,
        block.kind,
        null,
        block.text,
        true,
      ));
    }
    return out;
  }
}

/**
 * 会话里 agent **显式交付**给用户的一个文件。
 *
 * 来源是内核的结构化事件 `deliverables/presented`（`present` 工具触发）：
 * `data.files[] = { path, description }` —— 绝对路径 + 人写的说明，
 * **不是**从工具参数里猜出来的。
 */
export class ChatDeliverable {
  path: string;
  description: string | null;
  seq: number;

  constructor(path: string, description: string | null = null, seq: number = 0) {
    this.path = path;
    this.description = description;
    this.seq = seq;
  }
}

// ---------------------------------------------------------------------------
// 宽松取值（复刻 kotlinx 的 JsonPrimitive 语义）
// ---------------------------------------------------------------------------

/**
 * kotlinx `JsonPrimitive` 的取值语义，逐条复刻。
 *
 * 与直接读 JS 对象的两处关键差异：
 * - `contentOrNull` 对**数字/布尔**原语也给字符串（`1` → `'1'`），而非只认字符串；
 *   但对 `null` 给 null —— 这正是「缺键 vs 显式 null」在本层的分界。
 * - `intOrNull` 认的是**整数且在 int32 范围内**；`1.5`、`1e12` 都给 null，
 *   而不是像 JS 的 `Number()` 那样悄悄接受。
 */
class ChatJson {
  static obj(map: JsonMap | null, key: string): JsonMap | null {
    return JsonAccess.obj(map, key);
  }

  /** 对应 `JsonPrimitive.contentOrNull`。 */
  static str(map: JsonMap | null, key: string): string | null {
    const v: Object | null = JsonAccess.raw(map, key);
    if (v === null) {
      return null;
    }
    if (typeof v === 'string') {
      return v as string;
    }
    if (typeof v === 'number') {
      return `${v as number}`;
    }
    if (typeof v === 'boolean') {
      return (v as boolean) ? 'true' : 'false';
    }
    return null;
  }

  /** 对应 `JsonPrimitive.intOrNull`：非整数或越界一律 null。 */
  static int(map: JsonMap | null, key: string): number | null {
    const v: Object | null = JsonAccess.raw(map, key);
    if (v === null || typeof v !== 'number') {
      return null;
    }
    const n: number = v as number;
    if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
      return null;
    }
    return n;
  }

  /** 对应 `contentOrNull?.toBooleanStrictOrNull()`：只有字符串 `true`/`false` 认。 */
  static bool(map: JsonMap | null, key: string): boolean | null {
    const v: Object | null = JsonAccess.raw(map, key);
    if (v === null) {
      return null;
    }
    if (typeof v === 'boolean') {
      return v as boolean;
    }
    if (typeof v === 'string') {
      const s: string = v as string;
      if (s === 'true') {
        return true;
      }
      if (s === 'false') {
        return false;
      }
    }
    return null;
  }

  static arr(map: JsonMap | null, key: string): Object[] {
    return JsonAccess.arr(map, key);
  }

  /** 对应 `(a[member] as? JsonArray).mapNotNull { stringValue(field) }` + `distinct()`。 */
  static arrayLabels(map: JsonMap | null, member: string, field: string): string {
    const items: Object[] = ChatJson.arr(map, member);
    const values: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry: JsonMap | null = JsonAccess.asMap(items[i]);
      const label: string | null = ChatJson.str(entry, field);
      if (label !== null && isNotBlank(label) && values.indexOf(label) < 0) {
        values.push(label);
      }
    }
    return values.join(', ');
  }
}

// ---------------------------------------------------------------------------
// 文本工具（复刻 Kotlin 的 lineSequence / trimStart / substringAfterLast）
// ---------------------------------------------------------------------------

/** 对应 Kotlin `lineSequence()`：按 `\r\n` / `\n` / `\r` 三种行尾切分。 */
function kotlinLines(value: string): string[] {
  const parts: string[] = [];
  let start: number = 0;
  let i: number = 0;
  while (i < value.length) {
    const ch: string = value.charAt(i);
    if (ch === '\n') {
      parts.push(value.substring(start, i));
      i++;
      start = i;
    } else if (ch === '\r') {
      parts.push(value.substring(start, i));
      i++;
      if (i < value.length && value.charAt(i) === '\n') {
        i++;
      }
      start = i;
    } else {
      i++;
    }
  }
  parts.push(value.substring(start));
  return parts;
}

/** 对应 Kotlin `trimStart()`（按 `Char.isWhitespace()` 口径，与 JS trimStart 只差 U+FEFF）。 */
function trimStartWs(value: string): string {
  let i: number = 0;
  while (i < value.length && isKotlinWhitespace(value.charAt(i))) {
    i++;
  }
  return value.substring(i);
}

/** 对应 Kotlin `substringAfterLast(delimiter)`：找不到分隔符时返回原串。 */
function afterLast(value: string, delimiter: string): string {
  const at: number = value.lastIndexOf(delimiter);
  return at < 0 ? value : value.substring(at + delimiter.length);
}

/** 对应 Kotlin `substringAfterLast(delimiter, missingDelimiterValue = "")`。 */
function afterLastOrEmpty(value: string, delimiter: string): string {
  const at: number = value.lastIndexOf(delimiter);
  return at < 0 ? '' : value.substring(at + delimiter.length);
}

/** 对应 Kotlin `lineSequence().first()`。 */
function firstLine(value: string): string {
  const at: number = value.indexOf('\n');
  if (at >= 0) {
    return value.substring(0, at);
  }
  const cr: number = value.indexOf('\r');
  return cr >= 0 ? value.substring(0, cr) : value;
}

// ---------------------------------------------------------------------------
// 事件 → 显示项
// ---------------------------------------------------------------------------

/**
 * 从 `chat.message.delta` 帧里取出增量。
 *
 * `kind` 只认 `text`（→ ASSISTANT）与 `reasoning`（→ REASONING），其余整帧丢掉；
 * 五个必填字段（sessionId/turn/step/index/text）缺一个就返回 null，绝不填默认值猜。
 */
export function chatDelta(event: WorkspaceEvent): ChatDelta | null {
  if (event.type !== 'chat.message.delta') {
    return null;
  }
  const value: JsonMap | null = event.dataMap();
  if (value === null) {
    return null;
  }
  const kindText: string | null = ChatJson.str(value, 'kind');
  let kind: ChatItemKind;
  if (kindText === 'text') {
    kind = ChatItemKind.ASSISTANT;
  } else if (kindText === 'reasoning') {
    kind = ChatItemKind.REASONING;
  } else {
    return null;
  }
  const sessionId: string | null = ChatJson.str(value, 'sessionId');
  const turn: number | null = ChatJson.int(value, 'turn');
  const step: number | null = ChatJson.int(value, 'step');
  const index: number | null = ChatJson.int(value, 'index');
  const text: string | null = ChatJson.str(value, 'text');
  if (sessionId === null || turn === null || step === null || index === null || text === null) {
    return null;
  }
  return new ChatDelta(sessionId, turn, step, index, kind, text);
}

/**
 * 从 `chat.turn.failed` 帧里取出失败详情。
 *
 * 判据是 **type 精确等于** `chat.turn.failed`（插件 `normalizeDshEvent` 专门为
 * `turn/end` + `reason.kind === 'error'` 发的那帧），不是「任何带 failure 的帧」。
 * 这样做的好处是：插件没升级、老服务端只发普通 `chat.turn.end` 时，这里安静返回
 * null，客户端仍旧走原来的收尾路径，不会因为一个新字段抽风。
 */
export function chatTurnFailure(event: WorkspaceEvent): ChatTurnFailure | null {
  if (event.type !== 'chat.turn.failed') {
    return null;
  }
  const value: JsonMap | null = event.dataMap();
  if (value === null) {
    return null;
  }
  const failure: JsonMap | null = ChatJson.obj(value, 'failure');
  if (failure === null) {
    return null;
  }
  const message: string | null = ChatJson.str(failure, 'message');
  return new ChatTurnFailure(
    message === null ? '' : message,
    // 注意：空串 code 要**留空串**，不能退回 null。免费额度限流的 code 就是 ""，
    // 而界面要照原样显示「错误码：」后面那一格。
    ChatJson.str(failure, 'code'),
    ChatJson.bool(failure, 'stopped') === true,
  );
}

/** 对应 Kotlin 扩展函数 `ChatHistory.displayItems()`。 */
export function displayItemsOf(history: ChatHistory): ChatDisplayItem[] {
  // 先按 callId 把 tool/result 建成索引，再逐条渲染：
  // 结果的 callId 藏在 `data.message.toolCallId` 里，配对要跨事件 ——
  // 单看一条 entry 是配不上的（这正是以前 tool/result 整类被丢掉的原因）。
  const results: Map<string, ToolResultInfo> = toolResultsByCallId(history.events);
  const items: ChatDisplayItem[] = [];
  for (let i = 0; i < history.events.length; i++) {
    const one: ChatDisplayItem[] = oneEntryItems(history.events[i], results);
    for (let k = 0; k < one.length; k++) {
      items.push(one[k]);
    }
  }
  return mergeToolRuns(items);
}

/** 对应 Kotlin 扩展函数 `ChatHistory.todoItems()`。 */
export function todoItemsOf(history: ChatHistory): TodoItem[] {
  const projections: JsonMap | null = JsonAccess.asMap(history.projections);
  const values: JsonMap | null = ChatJson.obj(projections, 'values');
  if (values === null) {
    return [];
  }
  const raw: Object[] = ChatJson.arr(values, 'todos');
  const out: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: JsonMap | null = JsonAccess.asMap(raw[i]);
    if (item === null) {
      continue;
    }
    const content: string | null = ChatJson.str(item, 'content');
    if (content === null || isBlank(content)) {
      continue;
    }
    const status: string | null = ChatJson.str(item, 'status');
    if (status === null) {
      continue;
    }
    out.push(TodoItem.fromJson(item));
  }
  return out;
}

/** 对应 Kotlin 扩展函数 `ChatHistory.permissionSelect()`。 */
export function permissionSelectOf(history: ChatHistory): PermissionSelect | null {
  const projections: JsonMap | null = JsonAccess.asMap(history.projections);
  const values: JsonMap | null = ChatJson.obj(projections, 'values');
  if (values === null) {
    return null;
  }
  const raw: JsonMap | null = ChatJson.obj(values, 'permissions');
  if (raw === null) {
    return null;
  }
  const currentValue: string | null = ChatJson.str(raw, 'currentValue');
  if (currentValue === null) {
    return null;
  }
  const options: PermissionOption[] = [];
  const entries: Object[] = ChatJson.arr(raw, 'options');
  for (let i = 0; i < entries.length; i++) {
    const option: JsonMap | null = JsonAccess.asMap(entries[i]);
    if (option === null) {
      continue;
    }
    const value: string | null = ChatJson.str(option, 'value');
    const name: string | null = ChatJson.str(option, 'name');
    if (value === null || name === null) {
      continue;
    }
    options.push(new PermissionOption(value, name, ChatJson.str(option, 'description')));
  }
  return new PermissionSelect(options, currentValue);
}

/**
 * 取出会话里被显式交付的文件。
 *
 * 与 `SessionFileRefs` 是**两回事**：那个是从工具参数里嗅「提到过哪些路径」（带一堆
 * 刻意的取舍与白名单），这个读的是内核明说的「这是我给你的东西」，可靠度高得多、还带说明。
 *
 * 为什么以前客户端里看不到交付物：`displayItems` 只认 user/message、assistant/message、
 * tool/call 三类，`deliverables/presented` 落到兜底分支被整类丢掉。于是用户问
 * 「我要你写的报告呢、你打好的包呢」—— 数据一直在日志里，就是没人读。
 *
 * 同一个路径出现多次时保留**最后一次**的说明（后写的更新）。
 */
export function deliverablesOf(history: ChatHistory): ChatDeliverable[] {
  // Map 保持插入顺序：后写覆盖值，但键的位置仍是首次出现的位置。
  const out: Map<string, ChatDeliverable> = new Map();
  for (let i = 0; i < history.events.length; i++) {
    const event: SessionEvent = history.events[i].event;
    if (event.type !== 'deliverables/presented') {
      continue;
    }
    const data: JsonMap | null = event.dataMap();
    if (data === null) {
      continue;
    }
    const files: Object[] = JsonAccess.arr(data, 'files');
    for (let k = 0; k < files.length; k++) {
      const file: JsonMap | null = JsonAccess.asMap(files[k]);
      if (file === null) {
        continue;
      }
      const path: string | null = ChatJson.str(file, 'path');
      if (path === null || isBlank(path)) {
        continue;
      }
      out.set(path, new ChatDeliverable(path, ChatJson.str(file, 'description'), event.seq));
    }
  }
  const list: ChatDeliverable[] = [];
  out.forEach((value: ChatDeliverable): void => {
    list.push(value);
  });
  return list;
}

/**
 * 从附件 id 里解出交接路径；不是交接附件就返回 `null`。
 *
 * 界面只把 [ChatAttachment.attachmentId] 传给 ViewModel，于是「这个 id 是工作区路径、
 * 还是附件存储里的哈希」这个判据必须在两端共用同一份实现 —— 放这里，单测能直接钉住。
 */
export function handoffPathOf(attachmentId: string): string | null {
  if (!attachmentId.startsWith(HANDOFF_ATTACHMENT_PREFIX)) {
    return null;
  }
  const path: string = attachmentId.substring(HANDOFF_ATTACHMENT_PREFIX.length);
  return isNotBlank(path) ? path : null;
}

/** 一条 `tool/result` 的可用信息（内部结构，只在这个文件里流转）。 */
class ToolResultInfo {
  text: string;
  failed: boolean;
  time: number;

  constructor(text: string, failed: boolean, time: number) {
    this.text = text;
    this.failed = failed;
    this.time = time;
  }
}

function oneEntryItems(entry: HistoryEntry, toolResults: Map<string, ToolResultInfo>): ChatDisplayItem[] {
  const type: string = entry.event.type;
  if (type === 'user/message') {
    return userItems(entry.event);
  }
  if (type === 'assistant/message') {
    return assistantItems(entry.event);
  }
  if (type === 'tool/call') {
    return [toolItem(entry, toolResults)];
  }
  // 历史里的 `turn/end` 失败帧。
  //
  // 为什么必须在历史里也渲染：失败发生后用户往往**先退出再进会话**，或者往下翻记录。
  // 实时帧只到一次，过了就没了；历史是唯一能把「这一轮失败了、失败原因是什么」
  // 长期留住的地方。
  if (type === 'turn/end') {
    const item: ChatDisplayItem | null = turnEndItem(entry.event);
    return item === null ? [] : [item];
  }
  return [];
}

/**
 * 历史里的 `turn/end` 帧 → 失败行；不是失败就返回 null（整条不渲染）。
 *
 * 判据与插件 `turnFailureOf` **同一套**：`reason.kind === 'error'`，
 * 或 `aborted` 且原因是退出登录。`max-tokens` 不在这里 —— 那是「回答被截断」，
 * 官方渲染成黄色警示而非失败，客户端按普通收尾处理，不误报。
 */
function turnEndItem(event: SessionEvent): ChatDisplayItem | null {
  const data: JsonMap | null = event.dataMap();
  if (data === null) {
    return null;
  }
  const reason: JsonMap | null = ChatJson.obj(data, 'reason');
  if (reason === null) {
    return null;
  }

  let failure: ChatTurnFailure | null = null;
  const kind: string | null = ChatJson.str(reason, 'kind');
  if (kind === 'error') {
    // error 不是对象的兜底与插件 `turnFailureOf` 一致（`String(error)`）：
    // 内核偶尔会给一个字符串错误，那时消息本身就是信息，不能整条丢掉。
    const errorObj: JsonMap | null = ChatJson.obj(reason, 'error');
    let message: string | null = ChatJson.str(errorObj, 'message');
    if (message === null) {
      // 非对象形态：原语内容即信息（数字/布尔也照 contentOrNull 转字符串）。
      message = ChatJson.str(reason, 'error');
    }
    failure = new ChatTurnFailure(
      message === null ? '' : message,
      ChatJson.str(errorObj, 'code'),
      false,
    );
  } else if (kind === 'aborted') {
    const inner: JsonMap | null = ChatJson.obj(reason, 'reason');
    if (ChatJson.str(inner, 'kind') === 'hook'
      && ChatJson.str(inner, 'reason') === 'deepseek-account/signed-out') {
      failure = new ChatTurnFailure(
        // 文案由界面按 code 本地化；这里留空，免得纯逻辑层再写死一种语言。
        '',
        'ACCOUNT_SIGNED_OUT',
        true,
      );
    }
  }
  if (failure === null) {
    return null;
  }
  // message 为空（AUTH 被内核抹空）时仍然要显示 —— 那一行的标题与错误码就是信息。
  const code: string | null = failure.code;
  if (isBlank(failure.message) && (code === null || code.length === 0)) {
    return null;
  }
  return new ChatDisplayItem(`${event.seq}-turn-failure`, event.seq, ChatItemKind.FAILURE,
    null, '', false, [], [], [], failure);
}

function userItems(event: SessionEvent): ChatDisplayItem[] {
  const data: JsonMap | null = event.dataMap();
  if (data === null) {
    return [];
  }
  const source: JsonMap | null = ChatJson.obj(data, 'source');
  const kind: string | null = ChatJson.str(source, 'kind');
  // 交接说明**只可能出现在用户消息里**（插件改写的是用户发的那条 content）。
  // 上下文注入的正文里时不时就引用着路径 —— 记忆库文本、README 示例、上一轮的工具输出，
  // 拿真实会话跑一遍就抓到了：不设这道闸，那些正文会被切碎，还会凭空多出几张读不到的假附件。
  const isUser: boolean = kind === 'user';
  const parts: string[] = contentTextParts(JsonAccess.raw(data, 'content'));

  const handoffPaths: string[] = [];
  if (isUser) {
    for (let i = 0; i < parts.length; i++) {
      const found: string[] = handoffPathsIn(parts[i]);
      for (let k = 0; k < found.length; k++) {
        if (handoffPaths.indexOf(found[k]) < 0) {
          handoffPaths.push(found[k]);
        }
      }
    }
  }

  // 按**行**摘而不是整条 part 摘：实测插件把说明放在独立 part 里，但万一哪天和用户
  // 正文同处一条 part，整条摘掉会把用户自己打的话一起吞了。
  let body: string;
  if (isUser) {
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const stripped: string = stripHandoffLines(parts[i]);
      if (isNotBlank(stripped)) {
        kept.push(stripped);
      }
    }
    body = kept.join('\n\n');
  } else {
    body = contentText(JsonAccess.raw(data, 'content'));
  }

  const attachments: ChatAttachment[] = contentAttachments(JsonAccess.raw(data, 'content'));
  for (let i = 0; i < handoffPaths.length; i++) {
    attachments.push(handoffAttachment(handoffPaths[i]));
  }

  if (isUser) {
    // 判据是「有文字**或**有附件」。旧代码只判文字，于是「只发一张图、不打字」
    // 的消息会整条消失 —— 用户看到的正是「客户端里看不见图片」。
    if (isBlank(body) && attachments.length === 0) {
      return [];
    }
    return [new ChatDisplayItem(`${event.seq}-user`, event.seq, ChatItemKind.USER,
      null, body, false, attachments)];
  }
  return [new ChatDisplayItem(`${event.seq}-context`, event.seq, ChatItemKind.CONTEXT,
    contextLabel(source), body, false, attachments)];
}

/**
 * 从 content 数组里取出图片附件引用。
 *
 * 只认 `type == "image"`；`type == "file"` 的凭证（receiptId）指向的是一次上传的暂存区，
 * 与服务端持久化的附件存储不是同一套东西，硬接只会拿到 404。
 */
function contentAttachments(content: Object | null): ChatAttachment[] {
  const parts: Object[] = Array.isArray(content) ? content as Object[] : [];
  const out: ChatAttachment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const value: JsonMap | null = JsonAccess.asMap(parts[i]);
    if (value === null || ChatJson.str(value, 'type') !== 'image') {
      continue;
    }
    const attachment: JsonMap | null = ChatJson.obj(value, 'attachment');
    if (attachment === null) {
      continue;
    }
    const attachmentId: string | null = ChatJson.str(attachment, 'attachmentId');
    if (attachmentId === null || isBlank(attachmentId)) {
      continue;
    }
    const mediaType: string | null = ChatJson.str(attachment, 'mediaType');
    out.push(new ChatAttachment(
      attachmentId,
      mediaType === null ? '' : mediaType,
      ChatJson.int(attachment, 'width') ?? 0,
      ChatJson.int(attachment, 'height') ?? 0,
      ChatJson.int(attachment, 'bytes') ?? 0,
      ChatJson.str(attachment, 'name'),
    ));
  }
  return out;
}

/** 把交接说明的两行从一段正文里摘掉，其余原样保留。 */
function stripHandoffLines(part: string): string {
  const lines: string[] = kotlinLines(part);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i];
    if (line.indexOf(HANDOFF_SOURCE_MARKER) >= 0 || trimStartWs(line).startsWith(HANDOFF_PREAMBLE_MARKER)) {
      continue;
    }
    kept.push(line);
  }
  return trimText(kept.join('\n'));
}

/** 一条 text part 里出现的交接路径（正常是 0 或 1 条）。 */
function handoffPathsIn(part: string): string[] {
  const out: string[] = [];
  // 每次调用都新建 RegExp 实例：全局正则带 lastIndex 状态，复用会漏匹配。
  const pattern: RegExp = new RegExp(HANDOFF_SOURCE_PATTERN.source, 'g');
  let match: RegExpExecArray | null = pattern.exec(part);
  while (match !== null) {
    const path: string = trimText(match[1]);
    if (isNotBlank(path)) {
      out.push(path);
    }
    match = pattern.exec(part);
  }
  return out;
}

/**
 * 把一条交接路径变成**可直接显示**的附件。
 *
 * 用 `handoff:<绝对路径>` 当 [ChatAttachment.attachmentId]：它同时是图片缓存的键、
 * 去重的键和「从哪读字节」的唯一依据 —— 路径本身就能定位文件，不必再引一张 id 表。
 */
function handoffAttachment(path: string): ChatAttachment {
  let name: string = afterLast(path, '/');
  if (isBlank(name)) {
    name = path;
  }
  return new ChatAttachment(HANDOFF_ATTACHMENT_PREFIX + path, handoffMediaType(name),
    0, 0, 0, name, path);
}

function handoffMediaType(name: string): string {
  const ext: string = afterLastOrEmpty(name, '.').toLowerCase();
  if (ext === 'png') {
    return 'image/png';
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'gif') {
    return 'image/gif';
  }
  if (ext === 'bmp') {
    return 'image/bmp';
  }
  if (ext === 'heic') {
    return 'image/heic';
  }
  if (ext === 'heif') {
    return 'image/heif';
  }
  if (ext === 'avif') {
    return 'image/avif';
  }
  return '';
}

function assistantItems(event: SessionEvent): ChatDisplayItem[] {
  const outer: JsonMap | null = event.dataMap();
  if (outer === null) {
    return [];
  }
  const message: JsonMap | null = ChatJson.obj(outer, 'message');
  const scope: JsonMap = message === null ? outer : message;
  const content: Object | null = JsonAccess.raw(scope, 'content');

  if (!Array.isArray(content)) {
    const text: string = contentText(content);
    if (isNotBlank(text)) {
      return [new ChatDisplayItem(`${event.seq}-assistant`, event.seq, ChatItemKind.ASSISTANT,
        null, text)];
    }
    return [];
  }

  const blocks: Object[] = content as Object[];
  const result: ChatDisplayItem[] = [];
  const prose: string[] = [];

  // 散文段连续累积、遇到非文本块就整段 flush —— 这样「思考-正文-思考」不会被拼成一条。
  for (let i = 0; i < blocks.length; i++) {
    const value: JsonMap | null = JsonAccess.asMap(blocks[i]);
    if (value === null) {
      continue;
    }
    const type: string | null = ChatJson.str(value, 'type');
    if (type === 'text') {
      const text: string | null = ChatJson.str(value, 'text');
      if (text !== null && isNotBlank(text)) {
        prose.push(text);
      }
    } else if (type === 'reasoning') {
      if (prose.length > 0) {
        result.push(new ChatDisplayItem(`${event.seq}-assistant-${result.length}`, event.seq,
          ChatItemKind.ASSISTANT, null, prose.join('\n\n')));
        prose.length = 0;
      }
      const reasoning: string | null = ChatJson.str(value, 'text');
      if (reasoning !== null && isNotBlank(reasoning)) {
        result.push(new ChatDisplayItem(`${event.seq}-reasoning-${result.length}`, event.seq,
          ChatItemKind.REASONING, null, reasoning));
      }
    }
  }
  if (prose.length > 0) {
    result.push(new ChatDisplayItem(`${event.seq}-assistant-${result.length}`, event.seq,
      ChatItemKind.ASSISTANT, null, prose.join('\n\n')));
  }
  return result;
}

function toolItem(entry: HistoryEntry, toolResults: Map<string, ToolResultInfo>): ChatDisplayItem {
  const event: SessionEvent = entry.event;
  const data: JsonMap | null = event.dataMap();
  const name: string | null = ChatJson.str(data, 'name');
  const view: JsonMap | null = ChatJson.obj(JsonAccess.asMap(entry.view), 'view');
  const viewTitle: string | null = ChatJson.str(view, 'title');
  const description: string | null = ChatJson.str(view, 'description');
  const argumentsRaw: string | null = ChatJson.str(data, 'arguments');
  const actions: string[] = toolActionsFor(name === null ? '' : name, argumentsRaw);
  const callId: string | null = ChatJson.str(data, 'callId');
  const resolvedCallId: string = callId === null ? '' : callId;
  const result: ToolResultInfo | undefined = toolResults.get(resolvedCallId);

  // 正文优先级：view.description > arguments 摘要 > view.title > 工具名。
  let body: string = description === null ? '' : description;
  if (description === null) {
    const summary: string | null = argumentsSummary(argumentsRaw);
    if (summary !== null) {
      body = summary;
    } else if (viewTitle !== null) {
      body = viewTitle;
    } else {
      body = name === null ? '' : name;
    }
  }

  const detail: ToolCallDetail = new ToolCallDetail(
    resolvedCallId,
    name === null ? '' : name,
    argumentsRaw === null ? '' : argumentsRaw,
    result === undefined ? null : result.text,
    result !== undefined && result.failed,
    toolDurationMs(event.time, result === undefined ? null : result.time),
  );

  return new ChatDisplayItem(
    `${event.seq}-tool`,
    event.seq,
    ChatItemKind.TOOL,
    // 标题就是动作短语（官方口径），不再是 "Code" / "Read" 这种英文类别词。
    actions.join('，'),
    body,
    false,
    [],
    actions,
    [detail],
  );
}

/**
 * 把**连续**的工具调用合并成一项，标题报动作摘要。
 *
 * 与 WebView 页的 `toolGroupSummary` 同一口径：各条短语按首次出现顺序去重求并集，
 * 超过 4 条收尾加「等」。原生原先是一次调用一行，一跑几十次就是一屏行；网页版是一组一行。
 *
 * 只合并**相邻**的 TOOL —— 中间夹了正文就断开，那说明确实是两段工作。
 */
function mergeToolRuns(items: ChatDisplayItem[]): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = [];
  let run: ChatDisplayItem[] = [];

  const flush = (): void => {
    if (run.length === 0) {
      return;
    }
    if (run.length === 1) {
      out.push(run[0]);
      run = [];
      return;
    }
    const actions: string[] = [];
    for (let i = 0; i < run.length; i++) {
      const item: ChatDisplayItem = run[i];
      for (let k = 0; k < item.actions.length; k++) {
        if (actions.indexOf(item.actions[k]) < 0) {
          actions.push(item.actions[k]);
        }
      }
    }
    let title: string;
    if (actions.length === 0) {
      title = `${run.length} 次工具调用`;
    } else if (actions.length > 4) {
      title = `${actions.slice(0, 4).join('，')}等`;
    } else {
      title = actions.join('，');
    }

    const bodies: string[] = [];
    const tools: ToolCallDetail[] = [];
    for (let i = 0; i < run.length; i++) {
      bodies.push(run[i].body);
      for (let k = 0; k < run[i].tools.length; k++) {
        tools.push(run[i].tools[k]);
      }
    }
    out.push(run[0].withMerged(
      `tools-${run[0].seq}-${run[run.length - 1].seq}`,
      title,
      bodies.join('\n'),
      actions,
      // 合并的是**显示**，不是数据：每一调的明细都要留着，
      // 详情视图才能逐条展开（只留第一条 = 其余调用的输出全丢）。
      tools,
    ));
    run = [];
  };

  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === ChatItemKind.TOOL) {
      run.push(items[i]);
    } else {
      flush();
      out.push(items[i]);
    }
  }
  flush();
  return out;
}

function contentText(content: Object | null): string {
  const parts: string[] = contentTextParts(content);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (isNotBlank(parts[i])) {
      kept.push(parts[i]);
    }
  }
  return kept.join('\n\n');
}

/**
 * 把 content 拆成逐条文本。
 *
 * 与 [contentText] 的区别是**不合并**：交接说明必须能被整条摘掉，
 * 合并之后再按行切割就成了「拿分隔符当数据结构」。
 */
function contentTextParts(content: Object | null): string[] {
  if (content === null || content === undefined) {
    return [];
  }
  if (typeof content === 'string') {
    return [content as string];
  }
  if (typeof content === 'number') {
    return [`${content as number}`];
  }
  if (typeof content === 'boolean') {
    return [(content as boolean) ? 'true' : 'false'];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: Object[] = content as Object[];
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const value: JsonMap | null = JsonAccess.asMap(blocks[i]);
    if (value === null) {
      continue;
    }
    const type: string | null = ChatJson.str(value, 'type');
    if (type === 'text' || type === 'reasoning') {
      const text: string | null = ChatJson.str(value, 'text');
      if (text !== null) {
        out.push(text);
      }
    }
  }
  return out;
}

function contextLabel(source: JsonMap | null): string | null {
  if (source === null) {
    return null;
  }
  const kind: string | null = ChatJson.str(source, 'kind');
  if (kind === 'agent-instructions') {
    const labels: string = ChatJson.arrayLabels(source, 'changes', 'path');
    return labels.length === 0 ? null : labels;
  }
  if (kind === 'session-reference') {
    const labels: string = ChatJson.arrayLabels(source, 'references', 'label');
    return labels.length === 0 ? null : labels;
  }
  if (kind === 'plugin') {
    const plugin: string | null = ChatJson.str(source, 'plugin');
    return plugin === null ? kind : plugin;
  }
  if (kind === 'skill-invocation') {
    const name: string | null = ChatJson.str(source, 'name');
    return name === null ? kind : name;
  }
  return kind;
}

/**
 * 一个工具调用的**动作短语**，如 `['运行了代码', '已写入文件', '执行了命令']`。
 *
 * 措辞与判定方式都照官方 Web 界面还原（`@deepseek-ai/dsh-client-ui-chat`）：
 * 那边是内核给一个 `summary.counts[{kind}]`，按 kind 取 i18n 文案再拼；
 * 我们的会话事件里**没有**这个结构化字段（`tool/call` 无 view/description、
 * `tool/result` 无 meta，已逐条核实），所以只能按工具名与参数近似还原。
 *
 * `run_code` 的处理来自真实数据统计：1129 次调用的 arguments 里，
 * `tools.bash` 748 次、`tools.edit` 158、`tools.read` 116、`tools.write` 53；
 * 其中 `bash` + `write` 这一组合 42 例，对应的正是官方那句
 * 「运行了代码，已写入文件，执行了命令」—— 所以扫参数是**结论**，不是猜测。
 *
 * 顺序按官方措辞对齐：edit 先于 write（官方是「修改了文件，已写入文件」）。
 */
const INNER_ACTIONS: string[][] = [
  ['tools.edit', '修改了文件'],
  ['tools.write', '已写入文件'],
  ['tools.read', '读取了文件'],
  ['tools.bash', '执行了命令'],
  ['tools.grep', '搜索了内容'],
  ['tools.glob', '搜索了文件'],
];

const ACTIONS_BY_NAME: Map<string, string> = new Map<string, string>([
  ['bash', '执行了命令'],
  ['pwsh', '执行了命令'],
  ['read', '读取了文件'],
  ['write', '已写入文件'],
  ['edit', '修改了文件'],
  ['grep', '搜索了内容'],
  ['glob', '搜索了文件'],
  ['web_fetch', '已访问网页'],
  ['web_search', '已搜索网页'],
]);

export function toolActionsFor(name: string, argumentsRaw: string | null): string[] {
  const raw: string = argumentsRaw === null ? '' : argumentsRaw;
  if (name === 'run_code') {
    const out: string[] = ['运行了代码'];
    for (let i = 0; i < INNER_ACTIONS.length; i++) {
      const needle: string = INNER_ACTIONS[i][0];
      const phrase: string = INNER_ACTIONS[i][1];
      if (raw.indexOf(needle) >= 0 && out.indexOf(phrase) < 0) {
        out.push(phrase);
      }
    }
    return out;
  }
  const byName: string | undefined = ACTIONS_BY_NAME.get(name);
  if (byName !== undefined) {
    return [byName];
  }
  if (name.startsWith('mcp__')) {
    return [`调用了 ${name.substring(5).split('__').join(' · ')}`];
  }
  return [isNotBlank(name) ? name : '工具'];
}

/** arguments 里最像"一句话说明"的那个字段，取它的第一行。 */
const ARGUMENT_SUMMARY_KEYS: string[] = [
  'description', 'path', 'file_path', 'query', 'pattern', 'url', 'command', 'name', 'package',
];

function argumentsSummary(raw: string | null): string | null {
  if (raw === null || isBlank(raw)) {
    return null;
  }
  const parsed: JsonMap | null = JsonAccess.asMap(JsonAccess.parse(raw));
  if (parsed === null) {
    return null;
  }
  for (let i = 0; i < ARGUMENT_SUMMARY_KEYS.length; i++) {
    const key: string = ARGUMENT_SUMMARY_KEYS[i];
    const value: string | null = ChatJson.str(parsed, key);
    if (value !== null && isNotBlank(value)) {
      return firstLine(value);
    }
  }
  return null;
}

/**
 * 把 `tool/result` 按 callId 建索引。
 *
 * 关联字段优先用 `data.message.toolCallId`，退路是 `data.message.source.callId`：
 * 实测两者在 8006/8006 条里完全相等，但只认一个的话，内核哪天只留另一个就全配不上了。
 * 两个都拿不到的行直接跳过（宁可不显示，也不猜）。
 */
function toolResultsByCallId(events: HistoryEntry[]): Map<string, ToolResultInfo> {
  const out: Map<string, ToolResultInfo> = new Map();
  for (let i = 0; i < events.length; i++) {
    const event: SessionEvent = events[i].event;
    if (event.type !== 'tool/result') {
      continue;
    }
    const data: JsonMap | null = event.dataMap();
    if (data === null) {
      continue;
    }
    const message: JsonMap | null = ChatJson.obj(data, 'message');
    if (message === null) {
      continue;
    }
    let callId: string | null = ChatJson.str(message, 'toolCallId');
    if (callId === null) {
      callId = ChatJson.str(ChatJson.obj(message, 'source'), 'callId');
    }
    if (callId === null) {
      continue;
    }
    out.set(callId, new ToolResultInfo(toolResultText(message),
      ChatJson.bool(message, 'isError') === true, event.time));
  }
  return out;
}

/**
 * 一个工具结果的正文。
 *
 * 内核的 `message.content` 实测**一定是数组**（19050/19050），元素只有两种：
 * `text`（取 text）与 `image`（只有附件引用，字节在服务端附件存储里）。
 * 图片这里用一行占位写出来，而不是静默丢掉 —— 「这里本来有一张图」也是信息。
 *
 * 空段丢掉、段间空行，与网页版 `partsText(content, 'text')` 同一口径。
 */
function toolResultText(message: JsonMap): string {
  const content: Object | null = JsonAccess.raw(message, 'content');
  if (content === null) {
    return '';
  }
  if (!Array.isArray(content)) {
    const primitive: string | null = ChatJson.str(message, 'content');
    return primitive === null ? '' : primitive;
  }
  const parts: Object[] = content as Object[];
  const text: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part: JsonMap | null = JsonAccess.asMap(parts[i]);
    if (part === null) {
      continue;
    }
    const type: string | null = ChatJson.str(part, 'type');
    if (type === 'text') {
      const value: string | null = ChatJson.str(part, 'text');
      if (value !== null) {
        text.push(value);
      }
    } else if (type === 'image') {
      const attachment: JsonMap | null = ChatJson.obj(part, 'attachment');
      let name: string | null = ChatJson.str(attachment, 'name');
      if (name === null || isBlank(name)) {
        name = 'attachment';
      }
      const width: number = ChatJson.int(attachment, 'width') ?? 0;
      const height: number = ChatJson.int(attachment, 'height') ?? 0;
      if (width > 0 && height > 0) {
        text.push(`[image ${name} ${width}×${height}]`);
      } else {
        text.push(`[image ${name}]`);
      }
    }
  }
  const kept: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (isNotBlank(text[i])) {
      kept.push(text[i]);
    }
  }
  return kept.join('\n\n');
}

/**
 * 耗时 = `tool/result.time - tool/call.time`（都是 epoch 毫秒）。
 *
 * 结果为负说明时钟倒退（机器休眠恢复、NTP 校时 —— 实测日志里有一条 bash 差 9821 秒，
 * 那是挂起时间不是执行时间）。这种情况**不显示**，而不是显示一个负数或 0：
 * 宁可少一行，也不要瞎编。
 */
export function toolDurationMs(callTime: number, resultTime: number | null): number | null {
  if (resultTime === null) {
    return null;
  }
  const delta: number = resultTime - callTime;
  return delta < 0 ? null : delta;
}

/**
 * 耗时的人类可读格式。
 *
 * 刻意**不进字符串资源**：ms / s / m / h 是通用单位，翻成「毫秒/秒/分」只会更长、
 * 并不会更好读；而这一行本来就是元数据。边界都在单测里钉住。
 */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60000) {
    return `${oneDecimal(ms / 1000)} s`;
  }
  if (ms < 3600000) {
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/** 对应 Kotlin `"%.1f"`（HALF_UP）：只保留一位小数，且不带千分位/科学计数。 */
function oneDecimal(value: number): string {
  const tenths: number = Math.round(value * 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/**
 * 把内核给的 arguments 格式化成可读 JSON。
 *
 * `arguments` 是**字符串**（实测 12471/12471 可解析），塞进界面之前要缩进；
 * 但解析失败就原样返回 —— 宁可给一坨原始文本，也不要把参数藏起来
 * （真机上曾经因为「坏 JSON 一律丢弃」而让整条调用看起来没有输入）。
 *
 * 缩进宽度取 kotlinx `prettyPrint` 的 4 空格口径。
 */
export function prettyToolArguments(raw: string): string {
  if (isBlank(raw)) {
    return '';
  }
  const parsed: Object | null = JsonAccess.parse(raw);
  if (parsed === null) {
    return raw;
  }
  try {
    return JSON.stringify(parsed, null, 4);
  } catch (e) {
    return raw;
  }
}
