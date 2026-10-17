/**
 * 会话列表的**显示分组** —— 移植自原工程 `data/ChatDisplayGroups.kt`（223 行）。
 *
 * 把扁平的一串 `ChatDisplayItem` 按「过程 / 结论」二分：连续的过程项收成一个可折叠组，
 * 组头用 `ProcessGroupSummary.title()` 报一行摘要。
 *
 * ## 为什么要有这一层
 *
 * 原来页面是**扁平行列表**：一次跑 40 条工具调用就是一屏「执行了命令 / 读取了文件」，
 * 用户要往下翻很久才看到助手那句结论 —— 信息密度差。参考实现（Whaleness 的
 * `makeConversationDisplayEntries`）用的是二分法：顺序扫一遍，遇到「会渲染出可见正文」
 * 的项就把当前过程组 flush 掉。这里照抄的就是那条**二分边界**，只是判定用本工程的
 * `ChatItemKind`。
 *
 * 刻意只做**数据层**：分组、计数、摘要措辞。展开/折叠、动画、点击一律由界面决定
 * （组内只有 1 项时照样产出一个 `PROCESS_GROUP`，折不折是 UI 的事 ——
 * 数据层要是替 UI 做了这个决定，UI 就再也拿不到「这一项其实是一组」的信息了）。
 *
 * ## `ChatItemKind` 分类表（逐项给理由）
 *
 * | kind | 归哪类 | 理由 |
 * |---|---|---|
 * | `USER` | 消息 | 用户自己说的话，永远独立一行，折进去等于把提问藏了 |
 * | `ASSISTANT` | 消息 | 助手正文。**dsh-ui 卡片没有独立 kind** —— 它是正文里的围栏，由 `AssistantBody` 就地解析成原生组件，所以跟着 ASSISTANT 一起算消息 |
 * | `FAILURE` | 消息 | 终局失败（限流 / 配额 / 密钥 / 登出停止）是用户唯一能看到「为什么失败」的地方，折进过程组等于把答案藏起来 |
 * | `CONTEXT` | 过程 | 上下文注入（记忆库、AGENTS.md、插件、技能唤起…）：用户想知道「注入了 N 项」，不是逐条读正文 |
 * | `REASONING` | 过程 | 思考。历史与流式两处都已把它挡在消息流外（改由思考条承载），漏进来也不该占正文的位置 |
 * | `TOOL` | 过程 | 工具调用**同时也承载工具结果**：本工程把 `tool/result` 塞进 `tools[].result`，枚举里**没有**独立的 TOOL_RESULT —— 所以「工具调用 + 工具结果」在这里是同一个 kind |
 *
 * 兜底是「其余一律消息」：将来内核加了新 kind 而没人回来改这张表时，
 * **宁可少折叠一个，也不能把正文折进去**（折叠错了用户是真的看不到内容）。
 *
 * ## 纯函数
 *
 * 无副作用、不碰平台 API、**不读系统当前时间** —— 时间只从入参取，所以全部可断言。
 * 这是它被拆出来单测的全部意义：分组边界错了，真机上只表现为「有一段话不见了」，
 * 很难当场看出是哪一步错的。
 */

import { ChatDisplayItem, ChatItemKind } from './ChatPresentationTypes';

/** 会话列表的一行：要么是一条独立消息，要么是一个折叠的过程组。 */
export enum ChatDisplayEntryKind {
  MESSAGE = 'MESSAGE',
  PROCESS_GROUP = 'PROCESS_GROUP',
}

/**
 * 一行显示条目。
 *
 * 用「单一扁平类 + `kind` 判别」而不是两个子类 —— 与 `MdBlock` / `MessageSegment` /
 * `LiveChatBlock` 的既定写法一致，规避 ArkTS 的继承覆盖语法歧义。
 */
export class ChatDisplayEntry {
  kind: ChatDisplayEntryKind;
  /** 稳定 key：消息取 `item.id`，过程组取组内**首项** id。界面加 `process-` 前缀区分。 */
  id: string;
  /** `MESSAGE` 时非空。 */
  item: ChatDisplayItem | null;
  /** `PROCESS_GROUP` 时非空。 */
  items: ChatDisplayItem[];
  /** `PROCESS_GROUP` 时非空。 */
  summary: ProcessGroupSummary | null;

  constructor(kind: ChatDisplayEntryKind, id: string, item: ChatDisplayItem | null = null,
    items: ChatDisplayItem[] = [], summary: ProcessGroupSummary | null = null) {
    this.kind = kind;
    this.id = id;
    this.item = item;
    this.items = items;
    this.summary = summary;
  }

  static message(item: ChatDisplayItem): ChatDisplayEntry {
    return new ChatDisplayEntry(ChatDisplayEntryKind.MESSAGE, item.id, item);
  }

  static processGroup(id: string, items: ChatDisplayItem[], summary: ProcessGroupSummary): ChatDisplayEntry {
    return new ChatDisplayEntry(ChatDisplayEntryKind.PROCESS_GROUP, id, null, items, summary);
  }
}

/** 过程组摘要：标题一行显示的内容。 */
export class ProcessGroupSummary {
  /**
   * 工具调用次数 —— **按真实调用条数计，不是按显示行数**。
   *
   * 为什么不能直接数 TOOL 行：`mergeToolRuns` 早就把**相邻**的调用合并成了一行，
   * 而那行里的 `tools` 列表每一条仍是一次真实调用。直接数行会把一次
   * 「连续 5 次 bash」报成「1 次工具调用」，摘要就废了。
   * 所以规则是：带逐条明细的行按明细条数计，没有明细的行（拿不到 tool/call 数据）算 1 次。
   */
  toolCalls: number;
  /** 上下文注入条数。 */
  contextItems: number;
  /** 组内最早时刻（毫秒）；**`0` 表示没有时间**（与 `ChatDisplayItem.time` 同一约定）。 */
  startedAt: number;
  /** 组内最晚时刻（毫秒）；`0` 表示没有时间。 */
  finishedAt: number;

  constructor(toolCalls: number = 0, contextItems: number = 0, startedAt: number = 0, finishedAt: number = 0) {
    this.toolCalls = toolCalls;
    this.contextItems = contextItems;
    this.startedAt = startedAt;
    this.finishedAt = finishedAt;
  }

  /**
   * 组头的墙钟跨度（毫秒）；拿不到**可信**跨度时返回 0。
   *
   * 三种情况都返回 0 而不是负数：
   * - 两头缺一（只有时间戳的一半是拿不到的）；
   * - `finishedAt < startedAt`：时钟倒退（机器休眠恢复、NTP 校时，源工程实测日志里
   *   有一条 bash 差 9821 秒）—— 那是挂起时间不是执行时间；
   * - 跨度为 0：同一毫秒内的事件区间等于没有信息。
   *
   * 与 `toolDurationMs` 同一条纪律：宁可少一段，也不要瞎编一个数。
   *
   * 已知边界：这是**墙钟**跨度，所以「中间熄屏/挂起 3 小时」会被如实算进耗时 ——
   * 组级的 min/max 看不出中间断过，而单条工具耗时（`ToolCallDetail.durationMs`）
   * 只覆盖调用本身。用户要的那个数本来就是「从开始到结束有多久」，所以这里不额外修正，
   * 只把事实写清楚。
   */
  durationMs(): number {
    if (this.startedAt <= 0 || this.finishedAt <= 0) {
      return 0;
    }
    const span: number = this.finishedAt - this.startedAt;
    return span > 0 ? span : 0;
  }

  /**
   * 「耗时 1 分 12 秒 · 3 项上下文 · 5 次工具调用」；无耗时时省略耗时段。
   *
   * 三段按固定顺序拼，段间用 ` · `：这是**组标题的稳定版式**，
   * 顺序变了用户会觉得每一组都长得不一样。
   */
  title(): string {
    const segments: string[] = [];
    const span: number = this.durationMs();
    if (span > 0) {
      segments.push(`耗时 ${formatProcessSpan(span)}`);
    }
    if (this.contextItems > 0) {
      segments.push(`${this.contextItems} 项上下文`);
    }
    if (this.toolCalls > 0) {
      segments.push(`${this.toolCalls} 次工具调用`);
    }
    // 计数全 0、又没有时间时也得有一行字：组头不能是空白，空白看起来像渲染坏了。
    return segments.length === 0 ? FALLBACK_TITLE : segments.join(SEGMENTS_SEPARATOR);
  }
}

/** 计数全 0、又没有可信时间时的组标题 —— 组头不能是空白。 */
const FALLBACK_TITLE: string = '过程';

/** 摘要段之间的分隔符。 */
const SEGMENTS_SEPARATOR: string = ' · ';

/**
 * 把展示项按「过程 / 结论」二分：过程项聚成组，遇到消息类项则 flush。
 *
 * 只合并**连续**的过程项（中间夹了消息就断开）—— 中间那条消息说明确实是两段工作，
 * 硬并成一组会让「这一组干了什么」失去意义。
 *
 * @param timeOf 时间来源的接缝。默认直接取 `item.time`（本工程在移植批次 1 已经把
 *   `ChatDisplayItem.time` 补齐，历史项有值、流式项为 `0`）。传别的实现可以把时间
 *   换成另一个来源（例如按 id 去 `ChatHistory.events` 里查），本文件不必再改。
 *
 *   取到 `0` 一律当「没有时间」，**不是**「假装有时间」：宁可少一段，也不要编一个耗时。
 */
export function groupChatDisplay(items: ChatDisplayItem[],
  timeOf: (item: ChatDisplayItem) => number = (item: ChatDisplayItem): number => item.time): ChatDisplayEntry[] {
  const entries: ChatDisplayEntry[] = [];
  let run: ChatDisplayItem[] = [];

  const flushRun = (): void => {
    if (run.length === 0) {
      return;
    }
    // 先取出当前批次再换新表：ProcessGroup 持有的是这批本身，之后 run 指向新实例，
    // 不会因为后续 append 而被改写。
    const group: ChatDisplayItem[] = run;
    entries.push(ChatDisplayEntry.processGroup(group[0].id, group, summarizeProcessGroup(group, timeOf)));
    run = [];
  };

  for (let i = 0; i < items.length; i++) {
    const item: ChatDisplayItem = items[i];
    if (isProcessItem(item)) {
      run.push(item);
    } else {
      flushRun();
      entries.push(ChatDisplayEntry.message(item));
    }
  }
  // 收尾那次 flush：末尾是过程项时不会再有消息来触发它。
  flushRun();
  return entries;
}

/**
 * 这一项算「过程」还是「消息」。
 *
 * 判定表与文件头那张表一一对应，理由也写在那儿；这里只留一条**额外的保险**：
 * 任何带 `failure` 的项一律当消息。当前只有 FAILURE 会带这个字段，
 * 但只要谁把它带上了，它就不能被折进过程组 —— 用户找的就是那句「为什么失败了」。
 */
export function isProcessItem(item: ChatDisplayItem): boolean {
  if (item.failure !== null) {
    return false;
  }
  return item.kind === ChatItemKind.CONTEXT
    || item.kind === ChatItemKind.REASONING
    || item.kind === ChatItemKind.TOOL;
}

/** 数一遍组内有什么，并把时间夹到最早/最晚。 */
function summarizeProcessGroup(items: ChatDisplayItem[],
  timeOf: (item: ChatDisplayItem) => number): ProcessGroupSummary {
  let toolCalls: number = 0;
  let contextItems: number = 0;
  let startedAt: number = 0;
  let finishedAt: number = 0;

  for (let i = 0; i < items.length; i++) {
    const item: ChatDisplayItem = items[i];
    if (item.kind === ChatItemKind.TOOL) {
      // 有明细就按明细条数（合并行），没明细就算 1 次（拿不到 tool/call 数据）。
      toolCalls += item.tools.length === 0 ? 1 : item.tools.length;
    } else if (item.kind === ChatItemKind.CONTEXT) {
      contextItems += 1;
    }
    // 时间一律从 timeOf 取（默认 `item.time`），本函数不读任何当前时间。
    const at: number = timeOf(item);
    if (at <= 0) {
      continue;
    }
    if (startedAt === 0 || at < startedAt) {
      startedAt = at;
    }
    if (at > finishedAt) {
      finishedAt = at;
    }
  }
  return new ProcessGroupSummary(toolCalls, contextItems, startedAt, finishedAt);
}

/**
 * 「耗时」的措辞：不足 1 秒 → 「不足 1 秒」；<60 秒 → 「12 秒」；
 * ≥60 秒 → 「1 分 12 秒」，秒为 0 时省掉秒段（「2 分」）。
 *
 * 为什么单列「不足 1 秒」这一档：整秒取整会把 300 毫秒的组印成「耗时 0 秒」，
 * 而 0 秒读起来就是「没有耗时」，与「整段省略」的表达撞车，用户分不清。
 *
 * 为什么只到「分」为止：标题只有一行，真跑几小时的组在会话页里罕见，
 * 而且那时用户关心的是「它还在跑」而不是精确到小时。秒级取整（向下）足够。
 */
export function formatProcessSpan(ms: number): string {
  if (ms < 1000) {
    return '不足 1 秒';
  }
  const totalSeconds: number = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/**
 * 列表的稳定 key。
 *
 * 过程组的 key **必须带前缀**：组 id 取的是组内首项的 id，而那一项在展开时
 * 也会作为普通消息出现（单项平铺分支），两者若共用同一个 key，ArkUI 的 `ForEach`
 * 会认为是同一个条目 —— 展开/收起的瞬间会看到内容错位或闪动。
 */
export function chatDisplayEntryKey(entry: ChatDisplayEntry): string {
  return entry.kind === ChatDisplayEntryKind.MESSAGE ? entry.id : `process-${entry.id}`;
}
