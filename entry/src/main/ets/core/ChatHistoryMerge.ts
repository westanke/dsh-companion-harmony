/**
 * 历史合并纯函数 —— 对位 Android 源工程 `data/HistoryMerge.kt`。
 *
 * 刷新（`refreshHistory`）或实时事件触发的 `chatRefreshLoop` 拿回来的只是**最后一页**。
 * 如果用户此前已经点过「加载更早消息」，直接用新的一页替换会让列表中已经加载出来的
 * 历史凭空消失 —— 真机实测表现为「点加载更早 → 内容出现 → 一秒后整屏变空白」：
 * 列表条目从 5 条缩回 2 条，视口还停在原来的像素偏移上，落进了空白区。
 *
 * 所以刷新时把「新一页之前」的历史保留下来，只替换/追加新一页覆盖的区间。
 *
 * 纯函数，无副作用、不碰平台 API，便于单测（见 `test/cases/history-merge.test.ts`）。
 */

import { ChatHistory, HistoryEntry } from './Models';

/**
 * 把刷新拿回来的最后一页合并到已加载的历史中。
 *
 * 规则：
 * - previous 为空或空列表 → 直接返回 fresh
 * - previous 里 seq < freshFirst 的条目（更早的）保留，后面的由 fresh 覆盖
 * - hasMore 延续 previous 的值（只有 fresh 覆盖了整条列表时才会换）
 * - projections 有新就用新的，没有就沿用旧的
 */
export function mergeRefreshedHistory(previous: ChatHistory | null, fresh: ChatHistory): ChatHistory {
  if (previous === null || previous.events.length === 0) {
    return fresh;
  }
  let freshFirst: number | null = null;
  for (let i = 0; i < fresh.events.length; i++) {
    const seq: number = fresh.events[i].event.seq;
    if (freshFirst === null || seq < freshFirst) {
      freshFirst = seq;
    }
  }
  if (freshFirst === null) {
    return fresh;
  }
  const keptOlder: HistoryEntry[] = [];
  for (let i = 0; i < previous.events.length; i++) {
    if (previous.events[i].event.seq < freshFirst) {
      keptOlder.push(previous.events[i]);
    }
  }
  if (keptOlder.length === 0) {
    return fresh;
  }
  const merged: ChatHistory = new ChatHistory();
  merged.events = keptOlder.concat(fresh.events);
  // 之前还有更早的没读完，就别把「还能往前翻」的结论丢掉。
  merged.hasMore = previous.hasMore;
  // 新页带了 projections 就用新的，没有就沿用旧的（兜底）。
  merged.projections = fresh.projections !== null ? fresh.projections : previous.projections;
  return merged;
}
