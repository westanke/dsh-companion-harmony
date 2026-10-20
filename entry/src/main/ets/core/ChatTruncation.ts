/**
 * 「回答被截断」提示 —— 移植自原工程 `HarnessTruncationViewModel.kt` 与
 * `ChatModels.kt` 的 `isTurnMaxTokens()`。
 *
 * ## 这条提示为什么必须由客户端自己记
 *
 * 模型撞到输出 token 上限时，内核发的是
 * `turn/end { reason: { kind: 'max-tokens' } }` —— **不是**失败，
 * 所以插件不会发 `chat.turn.failed`（那一帧只给 error / 登出）。
 *
 * 而 `sessions.history` **不返回 `turn/end`**（源工程 2026-10-18 真机实测：
 * 一次取 293 条历史事件，`turn/end` 零条），所以重进会话时历史里也翻不到它。
 *
 * 两条路都断 ⇒ 唯一能拿到它的地方就是**实时帧**。于是这里做两件事：
 * 收到就把提示落进状态（跨历史刷新存活），下一轮开始时清掉。
 *
 * ## 历史侧还有一条独立的分支
 *
 * 万一哪天内核把 `turn/end` 写进历史，`ChatItemBuilders.turnEndItem()` 会把它
 * 映射成同一个 `TRUNCATED` 行 —— 两处判据共用 [isTurnMaxTokens]，
 * 免得「实时有、历史没有」或反过来。
 *
 * ## 真机症状
 *
 * 电脑端 WebUI 有那条黄色提示，App 里整条消失，用户只看到回答戛然而止。
 */

import { ChatDisplayItem, ChatItemKind } from './ChatPresentationTypes';
import { ChatJson } from './ChatJson';
import { JsonMap } from './JsonAccess';
import { WorkspaceEvent } from './Models';
import { HarnessState } from './HarnessTypes';

/**
 * 实时帧是不是「输出 token 上限」的那一帧。
 *
 * 判据逐字对齐源工程：`type === 'chat.turn.end'` **且**
 * `data.reason.kind === 'max-tokens'`。缺任一字段都返回 false ——
 * 宁可漏报（下一帧会补），也不要把普通收尾误报成截断。
 */
export function isTurnMaxTokens(event: WorkspaceEvent): boolean {
  if (event.type !== 'chat.turn.end') {
    return false;
  }
  const value: JsonMap | null = event.dataMap();
  if (value === null) {
    return false;
  }
  const reason: JsonMap | null = ChatJson.obj(value, 'reason');
  if (reason === null) {
    return false;
  }
  return ChatJson.str(reason, 'kind') === 'max-tokens';
}

/**
 * 造一条截断提示。
 *
 * `seq` 用 `0`：这条提示**没有持久位置**（历史里不存在），
 * 给个真序号只会让轨迹/日志里出现一个查无此号的值。
 */
export function truncatedItemFor(sessionId: string): ChatDisplayItem {
  return new ChatDisplayItem(`${sessionId}-turn-max-tokens`, 0, ChatItemKind.TRUNCATED);
}

/**
 * 当前会话该显示的截断提示（会话对不上就空）。
 *
 * 两个参数只取状态里的两个字段、不接整个 `HarnessState`：这是纯函数，
 * 单测不需要为了它拼一份完整界面状态。
 *
 * **语义**是「提示归属某一轮」—— 切到别的会话时 sessionId 对不上自然不显示，
 * 不需要在每个切换入口记得清一次。
 */
export function truncationItemsOf(noticeSession: string | null, notice: ChatDisplayItem | null,
  sessionId: string | null): ChatDisplayItem[] {
  if (sessionId !== null && noticeSession === sessionId && notice !== null) {
    return [notice];
  }
  return [];
}

/**
 * 就地把「这一轮边界」写进界面状态（对应源工程 `noteTurnBoundary` 的两个分支）：
 *
 * - 截断收尾 → 记下所属会话与提示本身；
 * - `chat.turn.start` 且提示属于本会话 → 上一轮的提示必须清掉，留着只会误导。
 *
 * 判据与 [isTurnMaxTokens] 同源，所以放在这里而不是 ViewModel 里；
 * ViewModel 只负责调用 `update()` 触发重绘（那边有行数预算）。
 */
export function applyTurnBoundary(state: HarnessState, event: WorkspaceEvent,
  sessionId: string | null): void {
  if (sessionId === null) {
    return;
  }
  if (isTurnMaxTokens(event)) {
    state.truncatedNoticeSession = sessionId;
    state.truncatedNotice = truncatedItemFor(sessionId);
    return;
  }
  if (event.type === 'chat.turn.start' && state.truncatedNoticeSession === sessionId) {
    state.truncatedNoticeSession = null;
    state.truncatedNotice = null;
  }
}
