/**
 * 会话列表的一行：**消息**直接渲染，**过程组**渲染成一行可折叠的摘要。
 *
 * 移植自原工程 `ui/chat/ChatProcessGroup.kt`（176 行）+ `data/ChatDisplayGroups.kt` 的
 * 展示面。分组算法在 `core/ChatDisplayGroups.ts`，这里只管怎么画。
 *
 * ## 为什么要分组
 *
 * 一次工具密集的回合会在会话里留下十几行「运行了代码 / 读取了文件 / 修改了文件」，
 * 把助手正文冲得七零八落。对比对象 Whaleness 的做法是把上下文 / 思考 / 工具调用
 * 收进一个过程组，组标题只留一行摘要（「耗时 1 分 12 秒 · 3 项上下文 · 5 次工具调用」），
 * 正文因此始终是主角。
 *
 * ## 为什么单项目不成组
 *
 * 组里只有一行时，折叠它只是让用户**多一次点击**才能看到本来就直接可见的内容。
 * 所以单项走平铺分支 —— 判据放在这里而不是数据层，因为「值不值得折」是观感问题，
 * 而数据层该保持可测的纯粹规则（它就是照着源工程这条分工抄的）。
 *
 * ## 展开态为什么由父组件持有
 *
 * 源工程用 `rememberSaveable`（不是 `remember`）：这张列表会被 LazyColumn 反复回收，
 * 用 `remember` 的话用户展开一组、往下滚两屏再滚回来，它会自己合上。
 * ArkUI 侧同理 —— `List` 会释放视口外的条目，组件自带的 `@State` 会跟着没。
 * 所以展开态放在 `ChatDetail`（单一数据源在父组件，见 `ui/ChatDetail.ets` 文件头），
 * 本组件只通过 `@Prop expanded` 读、通过 `onToggle` 请求切换。
 *
 * ## 折叠头的上下内距是踩出来的
 *
 * `padding({ top: 7, bottom: 7 })`：源工程真机反馈「时间重叠」指的其实就是这里 ——
 * 折叠头（含「耗时 1 分 12 秒 · 3 项上下文」那段摘要）与上下内容都贴得太近，
 * 而前几版一直在改消息流与 footer 的间距，**找错了对象**。
 */

import { ChatDisplayItem, ChatItemKind } from '../core/ChatPresentationTypes';
import { ChatDisplayEntry, ChatDisplayEntryKind } from '../core/ChatDisplayGroups';
import { ChatMessageView } from './ChatMessage';

/** 一条消息/过程项的渲染入口，组内外共用。 */
@Component
export struct ChatDisplayEntryRow {
  entry: ChatDisplayEntry = new ChatDisplayEntry(ChatDisplayEntryKind.MESSAGE, '');
  images: Map<string, Uint8Array> = new Map();
  failures: Map<string, string> = new Map();
  genUiDebug: boolean = false;
  onLoadImage: (id: string) => void = (): void => {};
  onAnswer: (text: string) => void = (): void => {};
  onRetry: () => void = (): void => {};
  /** 「从这条分叉」：透传给 `ChatMessageView`；确认对话框由 `ChatDetail` 持有。 */
  onFork: (atSeq: number) => void = (): void => {};
  /** 点消息里的图片 → 全屏查看；查看器由 `ChatDetail` 持有。 */
  onOpenImage: (bytes: Uint8Array, name: string) => void = (): void => {};

  /** 本组是否展开（只有多项目的过程组会用到；由父组件持有）。 */
  @Prop expanded: boolean = false;
  onToggle: () => void = (): void => {};

  /** 是否「折起来不值得」的单项目组 —— 这时按普通消息平铺。 */
  private flatSingle(): boolean {
    return this.entry.kind === ChatDisplayEntryKind.PROCESS_GROUP && this.entry.items.length <= 1;
  }

  /** 要平铺渲染的那一条（消息分支与单项组分支共用）。 */
  private flatItem(): ChatDisplayItem {
    if (this.entry.item !== null) {
      return this.entry.item;
    }
    if (this.entry.items.length > 0) {
      return this.entry.items[0];
    }
    // 兜底：结构上不该发生（两种分支都要求有 item），但宁可画一条空的，
    // 也不要让 `null` 顺着类型断言传进子组件。
    return new ChatDisplayItem('', 0, ChatItemKind.TOOL);
  }

  private groupTitle(): string {
    const summary = this.entry.summary;
    return summary === null ? '' : summary.title();
  }

  /** 渲染一条：组内外共用，故做成方法而不是内联两遍。 */
  @Builder
  chatItem(item: ChatDisplayItem) {
    Column() {
      ChatMessageView({
        item: item,
        images: this.images,
        failures: this.failures,
        genUiDebug: this.genUiDebug,
        onLoadImage: this.onLoadImage,
        onAnswer: this.onAnswer,
        onRetry: this.onRetry,
        onFork: this.onFork,
        onOpenImage: this.onOpenImage,
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ bottom: 5 })
  }

  /** 过程组折叠头：箭头 + 一行摘要，整行可点。 */
  @Builder
  groupHeader() {
    Row() {
      Text(this.expanded ? '⌄' : '›')
        .fontSize(15)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      Text(this.groupTitle())
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ left: 6 })
    }
    .width('100%')
    .padding({ left: 4, right: 4, top: 7, bottom: 7 })
    .borderRadius(6)
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      this.onToggle();
    })
  }

  build() {
    Column() {
      if (this.entry.kind === ChatDisplayEntryKind.MESSAGE || this.flatSingle()) {
        this.chatItem(this.flatItem())
      } else {
        this.groupHeader()
        if (this.expanded) {
          Column() {
            ForEach(this.entry.items, (item: ChatDisplayItem) => {
              this.chatItem(item)
            }, (item: ChatDisplayItem) => item.id)
          }
          .width('100%')
          .padding({ left: 10, top: 2 })
          .alignItems(HorizontalAlign.Start)
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
