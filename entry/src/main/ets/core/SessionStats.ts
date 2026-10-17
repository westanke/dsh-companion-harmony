/**
 * 会话的**执行统计** —— 移植自源工程 `data/SessionStats.kt`。
 * 全部来自历史事件，不需要内核额外提供任何东西。
 *
 * ## 为什么只有这些
 *
 * 竞品的统计表分三块：**执行**（轮次 / 步骤 / 工具调用）、**Token 用量**、**上下文**。
 * 后两块需要内核给出 usage 与上下文占用 —— 本工程的服务端契约里**不可证**：
 * bridge 原样透传内核事件，而「历史事件里有没有 usage 字段」从本仓库查不到。
 * 按「空结果的来源要验证」这条纪律，只做能证明的那部分，并把它当**事实**呈现。
 *
 * ## 为什么不做「按字符数估算 token」
 *
 * 误差可能成倍（不同模型 tokenizer 不同，且系统提示词与工具定义客户端根本看不到），
 * 而用户会拿它当真实占用做决策（「我还有多少余量」）。**一个不可靠的数字比没有数字更坏** ——
 * 它把「不知道」伪装成「知道」。
 *
 * ## 字段都是数出来的，不是猜出来的
 *
 * 事件类型名取自本工程既有的事件映射规则（`ChatItemBuilders` 已经在按这些类型分派渲染），
 * 所以这里的判据与渲染口径**同源**：将来渲染口径改了，统计口径也该一起改，
 * 而不是各自维护一套类型名清单。
 */

import { ChatHistory, HistoryEntry } from './ModelsEvents';

export class SessionStats {
  /** 用户轮次（`user/message` 条数）。 */
  turns: number = 0;
  /** 助手正文条数（`assistant/message`）。 */
  assistantMessages: number = 0;
  /** 工具调用（`tool/call`）。 */
  toolCalls: number = 0;
  /** 这次拿到的历史事件总数（分页时只是当前页）。 */
  events: number = 0;
  /** 最新事件序号 —— 用来判断这份统计的新鲜度。取不到时为 null。 */
  lastSeq: number | null = null;

  isEmpty(): boolean {
    return this.events === 0;
  }
}

/** 与渲染同源的三个事件类型名。 */
export const STATS_EVENT_USER: string = 'user/message';
export const STATS_EVENT_ASSISTANT: string = 'assistant/message';
export const STATS_EVENT_TOOL: string = 'tool/call';

/**
 * 从历史里数出执行统计。
 *
 * `history === null`（还没加载 / 加载失败）时返回空统计而不是抛错：面板显示「暂无数据」
 * 比弹一个错误合理 —— 用户只是点了下菜单。
 *
 * 注意 `seq` 取的是**最大序号**而不是最后一条的序号：历史在数组里不一定有序
 * （往前翻页时的合并、服务端给的顺序都不能当保证），拿 `events[last]` 会数出一个
 * 比实际小的值，而面板上「数据截至事件 #N」这个数字是要被用户拿去和别处对照的。
 */
export function sessionStatsOf(history: ChatHistory | null): SessionStats {
  const result: SessionStats = new SessionStats();
  if (history === null) {
    return result;
  }
  const events: HistoryEntry[] = history.events;
  if (events.length === 0) {
    return result;
  }
  let turns: number = 0;
  let assistants: number = 0;
  let tools: number = 0;
  let maxSeq: number = events[0].event.seq;
  for (let i = 0; i < events.length; i++) {
    const entry: HistoryEntry = events[i];
    const type: string = entry.event.type;
    if (type === STATS_EVENT_USER) {
      turns += 1;
    } else if (type === STATS_EVENT_ASSISTANT) {
      assistants += 1;
    } else if (type === STATS_EVENT_TOOL) {
      tools += 1;
    }
    if (entry.event.seq > maxSeq) {
      maxSeq = entry.event.seq;
    }
  }
  result.turns = turns;
  result.assistantMessages = assistants;
  result.toolCalls = tools;
  result.events = events.length;
  result.lastSeq = maxSeq;
  return result;
}
