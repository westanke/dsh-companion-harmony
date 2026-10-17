/**
 * 历史里**该显示**的那部分：滤掉思考，并按开关决定是否显示上下文注入 ——
 * 移植自源工程 `data/ChatVisibleItems.kt`。
 *
 * ## 为什么要单独一个纯函数
 *
 * 这段规则原来内联在 `ChatDetail` 的渲染方法里，有两个后果：
 * 1. **测不了** —— 「思考不进消息流」这条口径只能靠肉眼守；
 * 2. 每次重绘都会重跑一遍 —— 而 `displayItemsOf` 是**逐事件映射的纯函数**，
 *    流式期间每秒几十帧，每帧都把几百条历史事件重新映射一遍再跑两趟过滤，纯粹白烧 CPU。
 *
 * 抽出来之后规则可测，而上层只剩「拿 history 对象本身当缓存键」——
 * `history` 是**整份替换**的对象（只有刷新才变），引用相等就是「没变」的可靠判据。
 *
 * ## 两条过滤口径（与既有实现一致，只是搬了个位置）
 *
 * - **思考永不显示**：翻历史的人不读它；流式那一段也不进列表，由底部思考条承载 ——
 *   它是「运行状态」而不是「会话内容」。
 * - **上下文注入默认隐藏**：系统每轮塞进来的运行/时间上下文与后台任务通知，
 *   会在每条消息之间插一排折叠块，把正文挤得七零八落。开关在设置页。
 *
 * ## 流式项**不缓存**
 *
 * `liveItems` 每帧都在变，给它加缓存是**假优化**（每次都 miss，还多一次比较与拷贝）。
 * 所以这里只管历史那一半；上层对活的那一半照旧每帧现算。
 */

import { ChatDisplayItem, ChatItemKind } from './ChatPresentation';
import { displayItemsOf } from './ChatEventParsers';
import { ChatHistory } from './ModelsEvents';

/**
 * 过滤核（不碰 history，因此测试可以直接塞一串展示项）。
 *
 * 顺序照抄源工程：先滤思考再滤上下文。两条过滤互不重叠（一项不可能既是思考又是上下文），
 * 所以顺序不影响结果 —— 保持与源工程一致只是为了将来加第三条规则时对照方便。
 */
export function visibleItemsOf(items: ChatDisplayItem[], showContext: boolean): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item: ChatDisplayItem = items[i];
    if (item.kind === ChatItemKind.REASONING) {
      continue;
    }
    if (!showContext && item.kind === ChatItemKind.CONTEXT) {
      continue;
    }
    out.push(item);
  }
  return out;
}

/** `history` 为 null（还没加载）时返回空表，不抛错。 */
export function visibleHistoryItems(history: ChatHistory | null, showContext: boolean): ChatDisplayItem[] {
  if (history === null) {
    return [];
  }
  return visibleItemsOf(displayItemsOf(history), showContext);
}
