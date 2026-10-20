/**
 * 聊天页呈现模型 —— **第一层：类型与常量**（从 `ChatPresentation.ts` 拆出）。
 *
 * 装的是「服务端事件 → 界面一行行东西」这条路线上所有**数据形状**：
 * `ChatDisplayItem` / `ChatTurnFailure` / `ChatAttachment` / `ToolCallDetail`、
 * 流式增量（`ChatDelta` / `LiveChatBlock` / `LiveChatState`）、交付物（`ChatDeliverable`），
 * 以及交接说明（handoff）那几条标记常量。
 *
 * 上游的三条取向（只认能读懂的 / 不猜 / 分清「空串」与「没有」）与拆分来龙去脉
 * 写在 `ChatPresentation.ts` 的文件头 —— 那是本模块的索引。
 */

import { isNotBlank } from './TextPredicates';

/** 实时行的 seq 占位：Kotlin 用 `Int.MAX_VALUE`，保证它们排在历史之后。 */
export const LIVE_SEQ: number = 2147483647;

/** 交接说明里给机器读的那一行的标记；靠它把该行从正文里摘掉。 */
export const HANDOFF_SOURCE_MARKER: string = '[Image: source: ';

/** 交接说明里给人看的那一行的开头（`🖼️ 图片 1「shot.jpg」（…）`）。 */
export const HANDOFF_PREAMBLE_MARKER: string = '🖼️ 图片 ';

/**
 * 交接附件的 id 前缀：ViewModel / 界面靠它认出「这个 id 是一条文件路径，不是附件哈希」。
 */
export const HANDOFF_ATTACHMENT_PREFIX: string = 'handoff:';

/** `[Image: source: /abs/path.jpg]`；路径取到本行最后一个 `]`（路径里可能带空格）。 */
export const HANDOFF_SOURCE_PATTERN: RegExp = /\[Image: source:\s*(.+)]/g;

export enum ChatItemKind {
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
  REASONING = 'REASONING',
  CONTEXT = 'CONTEXT',
  TOOL = 'TOOL',
  FAILURE = 'FAILURE',
  /**
   * 模型撞到**输出 token 上限**、回答被截断时的那条提示。
   *
   * 与 [FAILURE] 分开是有意的，内核也是这么分的：它给的是**独立的
   * `turn-max-tokens` 节点**，而不是 `turn-error`（见内核
   * `TURN_PROCESS_INDEPENDENT_KINDS`，那里两者并列）。理由是语义：
   * 截断**不是失败** —— 已有的输出是有效内容，报成红框会让用户以为整轮白跑。
   * 渲染成黄色警示，文案对齐内核 `message.maxTokens` / `message.maxTokens.hint`。
   */
  TRUNCATED = 'TRUNCATED',
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
  /**
   * 这一条落盘的时刻（毫秒，取自服务端事件帧的 `time`）。
   *
   * **`0` 表示「没有时间」**，而不是「1970 年」：流式项还没落盘、以及任何服务端没给 `time`
   * 的老帧，都会落在这一档。界面靠它决定「不显示时间戳」，所以这个哨兵值必须是一个
   * 真实时间戳不可能取到的值（毫秒级 epoch 不可能是 0）——源工程用的是 `time: Long?`
   * 可空类型，ArkTS 这边用 `0` 表达同一件事，省掉每处调用点的判空。
   *
   * 为什么专门加这个字段：原来消息流里**没有任何时间信息**，用户翻到昨天的会话时
   * 无从判断那是今天还是上个月（见 `core/ChatTimeLabel.ts` 的分档理由）。
   */
  time: number;

  constructor(id: string, seq: number, kind: ChatItemKind, title: string | null = null, body: string = '',
    streaming: boolean = false, attachments: ChatAttachment[] = [], actions: string[] = [],
    tools: ToolCallDetail[] = [], failure: ChatTurnFailure | null = null, time: number = 0) {
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
    this.time = time;
  }

  /**
   * 派生一份「只改这几个字段」的副本（对应 Kotlin 的 `copy`）。
   *
   * 只给合并工具行用，所以只暴露那几个真正会被改的字段，不做通用的 copy 机。
   */
  withMerged(id: string, title: string, body: string, actions: string[], tools: ToolCallDetail[]): ChatDisplayItem {
    // `time` 跟着第一条走（= 这一批调用的开始时刻）：合并后这一行代表的是整批，
    // 取第一条才与「什么时候开始干的」对得上。
    return new ChatDisplayItem(id, this.seq, this.kind, title, body, this.streaming,
      this.attachments, actions, tools, this.failure, this.time);
  }

  /**
   * 派生一份「只换正文」的副本（对应源工程 `item.copy(body = linked)`）。
   *
   * 给正文文件链接化用（`core/PathLinks.ts`）：历史投影**带缓存**（`ui/ChatDetail.ets` 的
   * `projItems`），就地改 `body` 会把缓存里的那一条也一起改掉 —— 下次命中缓存拿到的就是
   * 「已经链接化过的正文」。虽然 `linkifyKnownFiles` 是幂等的（不会二次包裹），
   * 但缓存对象被外部改写这种副作用会随增量改动变成真 bug，所以照源工程的做法复制一份。
   */
  withBody(body: string): ChatDisplayItem {
    return new ChatDisplayItem(this.id, this.seq, this.kind, this.title, body, this.streaming,
      this.attachments, this.actions, this.tools, this.failure, this.time);
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
