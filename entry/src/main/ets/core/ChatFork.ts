/**
 * 消息级分叉点判据 —— 移植自源工程 `data/ChatForkPoint.kt`（逐条对应，一条都没省）。
 *
 * ## 为什么只给**用户消息**
 *
 * 从任意一条消息分叉在技术上都可以（内核按事件序号切），但界面上不能每条都挂一个按钮 ——
 * 那会让消息流变得毛糙，而分叉的真实使用场景几乎总是「这次提问的走向不对，从这儿重来」。
 * 所以只给用户消息，按钮藏在时间戳那一行里（次要动作放次要位置）。
 *
 * ## 为什么要求 `seq > 0`
 *
 * `seq` 是内核的事件序号，0 不是有效的分叉点（历史项才会有正 seq；流式项与本地占位项没有）。
 * 给内核传一个它不认识的分叉点只会得到一个报错弹窗，而用户完全不知道自己做错了什么 ——
 * 宁可不显示入口。
 *
 * 判据抽成纯函数并单测：它错了在真机上只表现为「某几条消息莫名多/少一个按钮」，
 * 当场看不出是哪一步错的（与过程分组同一条理由）。
 */

import { ChatDisplayItem, ChatItemKind } from './ChatPresentation';

/**
 * 这条展示项能不能作为分叉点？能就返回要传给 `forkSession` 的 `atSeq`（即这一条的 `seq`）。
 *
 * 返回 `null` 表示「不给入口」——调用方据此决定要不要渲染那个按钮，
 * 而**不是**「传 null 给接口」（接口那边 `atSeq = null` 是另一回事：整体分叉）。
 */
export function forkPointOf(item: ChatDisplayItem): number | null {
  return item.kind === ChatItemKind.USER && item.seq > 0 ? item.seq : null;
}
