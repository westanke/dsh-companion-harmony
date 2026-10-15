/**
 * 界面主状态机 —— **纯函数与传输辅助类型**（从 `HarnessViewModel.ts` 拆出）。
 *
 * 这些函数**不碰状态**、只吃参数吐结果，因此可以被任何一层复用，也是单测的主要抓手：
 * 主机命令行判定（`isHostCommandLine`）、问答刷新事件集合、问答移除（`removeQuestion`）、
 * 工具结果帧判定（`isToolResultFrame`）、会话停止标记（`markSessionStopped`）、
 * UTF-8 解码与拼接（`decodeUtf8` / `concatBytes`）、路径小工具（`childPath` / …切分）、
 * 以及去重（`distinctById`）。外加 `SessionFileOutcome` / `DecodedText` / `LiveKey`
 * 三个辅助类型与依赖注入口 `HarnessDeps`。
 *
 * 拆分来龙去脉见 `HarnessViewModel.ts`。
 */

import {
  ChatSession,
  CommandDescriptor,
  PendingQuestionSet,
} from './Models';
import {
  TimerBridge,
} from './DshClient';
import {
  ConnectionCoordinator,
  DshClientFactory,
} from './ConnectionCoordinator';
import {
  HostStore,
  KeyValueStore,
  SecretBox,
} from './HostStore';
import {
  AppPreferences,
} from './AppPreferences';
import {
  utf8DecodeStrict,
} from './Codec';
import {
  isBlank,
  isKotlinWhitespace,
  trimChar,
} from './TextPredicates';
import {
  JsonAccess,
} from './JsonAccess';
import {
  OpenDocument,
  SessionFileOpen,
  PendingAttachment,
} from './HarnessTypes';

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
export class SessionFileOutcome {
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
export class DecodedText {
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
export class LiveKey {
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
export function decodeUtf8(bytes: Uint8Array): DecodedText | null {
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
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
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
export function childPath(parent: string, name: string): string {
  return isBlank(parent) ? trimChar(name, '/') : `${parent}/${trimChar(name, '/')}`;
}

/** `substringBeforeLast('/', "")` 的行为（缺分隔符时返回空串）。 */
export function substringBeforeLast(value: string, sep: string): string {
  const at: number = value.lastIndexOf(sep);
  return at < 0 ? '' : value.substring(0, at);
}

/** `substringAfterLast('/', "")` 的行为（缺分隔符时返回空串）。 */
export function substringAfterLast(value: string, sep: string): string {
  const at: number = value.lastIndexOf(sep);
  return at < 0 ? '' : value.substring(at + sep.length);
}

/** 按 id 去重（保留先出现的那条），对应 Kotlin `distinctBy { it.id }`。 */
export function distinctById(attachments: PendingAttachment[]): PendingAttachment[] {
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
