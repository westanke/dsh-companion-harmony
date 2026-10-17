/**
 * 状态条：**思考条与「内容由 AI 生成」标识合并成同一条**。
 *
 * 移植自原工程 `ui/chat/ChatComposer.kt` 的 `ChatStatusBar` / `AiGeneratedNotice` /
 * `ChatThinkBar` 三个函数（真机反馈五修，2026-10-17）。
 *
 * ## 为什么合并
 *
 * 原来两者是并排的两行（思考条 + 标识条），思考一来就把标识挤到上面去，那一栏就散了。
 * 现在合成一条：**有思考内容时显示思考**（可展开），**没有思考时才显示标识**。
 *
 * 为什么这样合并而不是「标识常驻、思考叠上去」：那一栏只有一行多的空间，两条各占一行
 * 必然互相挤压；而思考只在流式期间存在，标识却是常驻的合规提示 —— 让「短生命周期的
 * 运行状态」让位给「常驻标识」不划算，反过来才对：思考在时用户看思考，
 * 不在时标识补位。
 *
 * 位置仍然固定在消息区**下方**、输入区**上方**（网页版 `#thinkbar` 的位置）：
 * 它是「运行状态 / 标识」而不是「会话内容」，进消息列表会随消息滚走。
 *
 * ## 标识的合规依据
 *
 * 《人工智能生成合成内容标识办法》第四条：应当在生成合成内容或者交互场景界面中添加、
 * 可以被用户明显感知到的**显式标识**。
 *
 * 为什么做成常驻条而不是弹窗/一次性浮层：第四条的措辞是「界面中添加…提示标识」，
 * 常驻优于一次性提示；弹窗类方案会打断会话，且「已关闭不再提示」之后用户就再也看不到
 * 标识，反而更不合规。
 *
 * 尺寸刻意弱于正文（11vp + 次级色）：它是常驻合规提示，不是正文的一部分，
 * 抢注意力会干扰长会话阅读。
 *
 * 免责范围说明：本 App 是**纯客户端**，生成方是用户自己部署的 DSH 服务端、模型由用户
 * 自行配置，内容不出用户自己的地址。这条标识是按「从严」口径加的，不改变本 App
 * 在资质上的定性（那由服务端承担）。
 *
 * ## 展开的折叠态为什么要记住
 *
 * 这条在流式期间随每个 token 重建，用普通成员会在这类高频重建里丢掉展开态
 * （用户刚点开就又合上），所以展开态用 `@State`。
 * 限高 240vp + 内部滚动：展开全文不能把输入区顶出屏幕。
 */

import { thinkBarFullText, thinkBarText } from '../core/ChatThinkBar';

/** 展开后的高度上限（vp）：对位源工程 `heightIn(max = 240.dp)`。 */
const EXPANDED_MAX_HEIGHT_VP: number = 240;

@Component
export struct ChatStatusBar {
  /**
   * 流式思考的**原文**（`liveThinkingText(live.blocks)`）。
   *
   * 传原文而不是截好的摘要：折叠态显示尾部 140 字符、展开态要显示全文，
   * 两个形态都得有 —— 截断放在组件内部做（`thinkBarText`），调用方不必算两遍。
   */
  @Prop rawThinking: string = '';

  /** 展开全文；思考内容一变就会被重建，所以必须是 `@State` 才记得住。 */
  @State expanded: boolean = false;

  /** 思考是否真的存在（空白串算没有，见 `core/ChatThinkBar.ts`）。 */
  private hasThinking(): boolean {
    return thinkBarText(this.rawThinking).length > 0;
  }

  /** 折叠态那一行：尾部摘要。 */
  private collapsedText(): string {
    return thinkBarText(this.rawThinking);
  }

  /** 展开态的全文：只折空白，不截断。 */
  private expandedText(): string {
    return thinkBarFullText(this.rawThinking);
  }

  /** 生成合成内容标识条：常驻一行，居中、次级色。 */
  @Builder
  aiNotice() {
    Row() {
      Text($r('app.string.ai_generated_notice'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 4, bottom: 4 })
    .justifyContent(FlexAlign.Center)
  }

  /** 思考条：转圈 + 一行摘要，点一下展开全文。 */
  @Builder
  thinkBar() {
    Column() {
      Divider()
        .strokeWidth(1)
        .color($r('sys.color.ohos_id_color_list_separator'))
      if (this.expanded) {
        Scroll() {
          Text(this.expandedText())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
        }
        .scrollable(ScrollDirection.Vertical)
        .width('100%')
        .constraintSize({ maxHeight: EXPANDED_MAX_HEIGHT_VP })
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .scrollBar(BarState.Off)
      } else {
        Row() {
          LoadingProgress()
            .width(13)
            .height(13)
            .color($r('sys.color.ohos_id_color_text_secondary'))
          Text(this.collapsedText())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ left: 7 })
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .alignItems(VerticalAlign.Center)
      }
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(HorizontalAlign.Start)
    .onClick((): void => {
      this.expanded = !this.expanded;
    })
  }

  build() {
    Column() {
      if (this.hasThinking()) {
        this.thinkBar()
      } else {
        this.aiNotice()
      }
    }
    .width('100%')
  }
}
