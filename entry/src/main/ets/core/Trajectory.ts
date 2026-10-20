/**
 * 「轨迹」页的数据：把历史事件按**轮次**分组，组内是按时序排列的节点 ——
 * 移植自源工程 `data/Trajectory.kt`。
 *
 * ## 它与会话流（`displayItems`）的区别
 *
 * 会话流是**给人读的**：只留正文、推理摘要、工具摘要，其余全部折叠或丢弃。
 * 轨迹是**给人查的**：每一轮里到底发生了什么、各花了多久、哪些是工具调用 ——
 * 排查「这一步为什么慢」「它到底调了什么」时看的是这个页面。
 *
 * 所以这里不做**二次加工**：认得的语义事件都留成节点（不认的类型归 `OTHER`）——
 * 轨迹页的价值恰恰在于「把当时发生的都列出来」，隐藏它等于让它失去意义。
 * 唯一被丢弃的是**不构成记录**的实现细节帧（step 边界、内部日志），判据见
 * `trajectoryKindOf` —— 那一层过滤是源工程踩过「第一屏全是其他事件」才加的。
 *
 * ## 数据全部来自历史事件，不需要服务端额外配合
 *
 * 判据与渲染同源：事件类型名取自本工程既有的映射规则，`turn` 取自事件自己的 `data.turn`
 * （规范化时由插件写入），取不到就归入 `UNKNOWN_TURN`。
 */

import { ChatHistory, HistoryEntry } from './ModelsEvents';
import { JsonAccess, JsonMap } from './JsonAccess';

export enum TrajectoryNodeKind {
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
  TOOL = 'TOOL',
  DELIVERABLE = 'DELIVERABLE',
  TURN_END = 'TURN_END',
  /** 认得的历史事件类型之外的一切 —— 刻意保留，见上面文件头。 */
  OTHER = 'OTHER',
}

/** 时间轴上的一个节点。 */
export class TrajectoryNode {
  seq: number = 0;
  time: number = 0;
  kind: TrajectoryNodeKind = TrajectoryNodeKind.OTHER;
  /**
   * 事件的**类型原名**（内核给的那个字符串，如 `step/end`）。
   *
   * 刻意存原文而不是只存 `kind`：轨迹页是排查工具，遇到不认识的类型时，
   * 用户要的正是「它到底叫什么」。存下来就能原样显示，不必去猜、也不必显示「其他」。
   */
  eventType: string = '';
  /** 短标签（工具名之类）；没有就为 null，UI 用 `kind` 或 `eventType` 兜底。 */
  label: string | null = null;
  /**
   * 事件的**原始 `data`**，供详情里的「原始」一栏展示。
   *
   * 刻意存原样而不是解析后的字段：轨迹页是排查工具，用户要能看到「当时真正收到了什么」——
   * 只给解析结果等于把「我们不认识的字段」永久藏起来。
   */
  raw: Object | null = null;

  constructor(seq: number, time: number, kind: TrajectoryNodeKind, eventType: string,
    label: string | null = null, raw: Object | null = null) {
    this.seq = seq;
    this.time = time;
    this.kind = kind;
    this.eventType = eventType;
    this.label = label;
    this.raw = raw;
  }
}

/** 一轮（一个 `turn`）及其节点。 */
export class TrajectoryTurn {
  turn: number = UNKNOWN_TURN;
  nodes: TrajectoryNode[] = [];

  constructor(turn: number, nodes: TrajectoryNode[]) {
    this.turn = turn;
    this.nodes = nodes;
  }

  /** 按序号排好的节点（起止与耗时都以**序号顺序**为准，不以数组顺序）。 */
  private ordered(): TrajectoryNode[] {
    const copy: TrajectoryNode[] = this.nodes.slice();
    copy.sort((a: TrajectoryNode, b: TrajectoryNode): number => a.seq - b.seq);
    return copy;
  }

  /** 这一轮第一个节点的时间；没有节点时为 null。 */
  startedAt(): number | null {
    const seq: TrajectoryNode[] = this.ordered();
    return seq.length === 0 ? null : seq[0].time;
  }

  /** 最后一个节点的时间。 */
  endedAt(): number | null {
    const seq: TrajectoryNode[] = this.ordered();
    return seq.length === 0 ? null : seq[seq.length - 1].time;
  }

  /**
   * 这一轮的墙钟跨度。
   *
   * 三个「不给值」的情形，每一个都比显示一个数字更诚实：
   * - **时间戳不随序号单调**（乱序）：说明这份历史的 `time` 不可信（时钟回拨、上游只填了部分、
   *   或事件数组顺序本身乱了）。此时算出来的只是「最晚减最早」，与「这一轮花了多久」不是一回事。
   * - **跨度为零**（全部同一时刻，常见于时间戳缺失被填 0）：显示 `0 秒` 会让人以为「瞬间完成」。
   * - 节点不足两个。
   */
  durationMillis(): number | null {
    const seq: TrajectoryNode[] = this.ordered();
    if (seq.length < 2) {
      return null;
    }
    let previous: number = seq[0].time;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].time < previous) {
        return null;
      }
      previous = seq[i].time;
    }
    const start: number = seq[0].time;
    const end: number = seq[seq.length - 1].time;
    return end > start ? end - start : null;
  }

  toolCalls(): number {
    let count: number = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].kind === TrajectoryNodeKind.TOOL) {
        count += 1;
      }
    }
    return count;
  }
}

/** `turn` 取不到时的归属。用 0 而不是 -1：负数会在排序与展示上制造新的特例。 */
export const UNKNOWN_TURN: number = 0;

/**
 * 把历史折成轨迹。
 *
 * - 轮次按 `turn` 升序，组内按 `seq` 升序（事件在数组里不一定有序，不能依赖顺序）；
 * - `turn` 取不到的事件归入 `UNKNOWN_TURN`（**不丢弃**）——它们在「发生过什么」这件事上
 *   仍然是证据，只是归属不明；
 * - `history === null`（还没加载）返回空列表。
 *
 * 分组用 `Map` 而不是对象：key 是数字，`Map` 的插入顺序 + 数字比较排序比「对象键会被
 * 字符串化」可靠（`{10: …, 9: …}` 的键顺序不是插入顺序）。
 */
export function trajectoryOf(history: ChatHistory | null): TrajectoryTurn[] {
  if (history === null) {
    return [];
  }
  const events: HistoryEntry[] = history.events;
  if (events.length === 0) {
    return [];
  }
  const grouped: Map<number, TrajectoryNode[]> = new Map<number, TrajectoryNode[]>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i].event;
    const kind: TrajectoryNodeKind | null = trajectoryKindOf(event.type);
    // 不构成记录的噪音帧（step 边界、内部日志）直接跳过 —— 判据见 `trajectoryKindOf`。
    if (kind === null) {
      continue;
    }
    const data: JsonMap | null = event.dataMap();
    const turn: number = JsonAccess.num(data, 'turn') ?? UNKNOWN_TURN;
    let bucket: TrajectoryNode[] | undefined = grouped.get(turn);
    if (bucket === undefined) {
      bucket = [];
      grouped.set(turn, bucket);
    }
    bucket.push(new TrajectoryNode(event.seq, event.time, kind, event.type,
      toolLabelOf(event.type, data), event.data));
  }

  const turns: number[] = [];
  grouped.forEach((_value: TrajectoryNode[], key: number): void => {
    turns.push(key);
  });
  // 真实轮次按 turn 升序在前，**未知轮次永远垫底**。
  //
  // 不只是好看：`turn` 缺失的多是 splice 进来的消息、compaction 这类边缘记录，
  // 数量不固定、信息密度还低。放在最前面会把真正的轮次顶出第一屏 ——
  // 真机反馈「第一屏全是其他事件」正是这么来的（源工程 `Trajectory.kt` 同样口径）。
  turns.sort((a: number, b: number): number => {
    const unknownA: number = a === UNKNOWN_TURN ? 1 : 0;
    const unknownB: number = b === UNKNOWN_TURN ? 1 : 0;
    return unknownA !== unknownB ? unknownA - unknownB : a - b;
  });

  const out: TrajectoryTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const nodes: TrajectoryNode[] = grouped.get(turns[i]) ?? [];
    nodes.sort((a: TrajectoryNode, b: TrajectoryNode): number => a.seq - b.seq);
    out.push(new TrajectoryTurn(turns[i], nodes));
  }
  return out;
}

/**
 * 轨迹页用的**短耗时**：不足一分钟给 `12.3s`，否则给 `3:05`。
 *
 * 为什么不用资源字符串：时间数字在各语言里的写法基本一致，做成资源会让这里的纯函数
 * 失去可测性（要跑起来才能取字符串）。单位符号 `s` 与 `m:ss` 都是国际通用写法。
 */
export function shortDuration(millis: number): string {
  if (millis < 60000) {
    const tenths: number = Math.floor(millis / 100);
    return `${Math.floor(tenths / 10)}.${tenths % 10}s`;
  }
  const totalSeconds: number = Math.floor(millis / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  const padded: string = seconds < 10 ? `0${seconds}` : `${seconds}`;
  return `${minutes}:${padded}`;
}

/**
 * 事件类型 → 轨迹节点类别；`null` 表示**这一帧不进轨迹**。
 *
 * ## 为什么要过滤（对齐源工程，2026-10-17 那边真机反馈）
 *
 * 用户看到轨迹第一屏是 #0~#26 一整列「其他事件」，有效信息要往下翻。
 * 对着真实会话数了一下，265 个事件里**一半是纯噪音**：
 *
 * | 类型 | 数量 | 是什么 |
 * |---|---|---|
 * | `step/start` / `step/end` | 42 + 42 | 每步的边界帧，同一轮里重复几十次 |
 * | `session-log-deepseek/delivery-accepted` | 42 | 内部投递日志 |
 * | `agent/inbox/spliced` | 4 | 收件箱拼接，内部簿记 |
 *
 * 这些都不是「发生过什么」的证据，只是实现细节。官方 Web 的轨迹
 * （`@deepseek-ai/dsh-client-ui-trajectory`）只收 User / Assistant / Tool /
 * subtool / compaction 这些**真正有语义的记录**，step 只作为边界标记、不单独成行。
 *
 * `tool/result` 也**不进**：它是 `tool/call` 的产物，详情在工具行里能展开看到；
 * 单独成行会让「一次工具调用」在轨迹里占两行，读起来像调用了两次。
 *
 * 移植侧最初没有这层过滤，真机上满屏 `job/registered`、`step/start` 这类原始事件名，
 * 用户的原话是「不认识」—— 这一节的判据不是排版偏好，而是可读性的前提。
 */
function trajectoryKindOf(type: string): TrajectoryNodeKind | null {
  if (type === 'user/message') {
    return TrajectoryNodeKind.USER;
  }
  if (type === 'assistant/message') {
    return TrajectoryNodeKind.ASSISTANT;
  }
  if (type === 'tool/call') {
    return TrajectoryNodeKind.TOOL;
  }
  if (type === 'deliverables/presented') {
    return TrajectoryNodeKind.DELIVERABLE;
  }
  if (type === 'turn/end') {
    return TrajectoryNodeKind.TURN_END;
  }
  // 以下都是实现细节，不构成「发生过什么」的记录。
  if (type === 'tool/result' || type === 'step/start' || type === 'step/end' || type === 'turn/start') {
    return null;
  }
  if (type.startsWith('session-log-') || type.startsWith('agent/inbox/')) {
    return null;
  }
  return TrajectoryNodeKind.OTHER;
}

/**
 * 把节点的原始载荷排成**缩进过的 JSON**（详情展开时用）。
 *
 * 为什么必须缩进：服务端给的是紧凑单行，几十个字段挤在一条里没法读；
 * 轨迹页的价值就是「看清当时到底收到了什么」，糊成一坨等于没有。
 * `raw === null` 返回 `null`，由 UI 显示「这条事件没有载荷」——
 * 这里不返回空串，是为了让「没有载荷」与「载荷是空对象」在界面上可区分。
 */
export function prettyPayload(raw: Object | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch (err) {
    // 循环引用等极端情况：退回原始串，至少不吞掉内容。
    return `${raw}`;
  }
}

/**
 * 工具的标签取 `data.name`；内核若把它放在别处就返回 null（UI 用类型名兜底）。
 * 刻意**不**去猜多个候选字段名 —— 猜错会显示一个假的工具名，而「不知道」是可接受的展示。
 */
function toolLabelOf(type: string, data: JsonMap | null): string | null {
  if (type !== 'tool/call') {
    return null;
  }
  const name: string | null = JsonAccess.str(data, 'name');
  if (name === null || name.trim().length === 0) {
    return null;
  }
  return name;
}
