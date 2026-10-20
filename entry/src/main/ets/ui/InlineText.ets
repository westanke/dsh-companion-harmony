/**
 * 一行（或一段）**可点的行内文本** —— 本工程 Markdown 渲染器的链接补丁。
 *
 * ## 为什么有这个组件
 *
 * 源工程的 Markdown 库会把 `[文字](目标)` 渲染成带 `LinkAnnotation.Url` 的链接，
 * 再由 `ui/chat/ChatLinkHandlers.kt` 统一分流。本工程的渲染器是自研的，行内标记一律
 * 由 `inlineMarkup` **拍平成纯文字** —— 显示上没差别，但链接**点不动**：
 * 源工程 2026-10-19 真机上「正文里那个文件打不开」「点了完全没反应」就是这个缺口。
 *
 * 补法：`core/InlineSegments.ts` 先把文本切成「普通文字 / 链接」，这里再把每段装成一个
 * `Span`，链接那一段挂 `onClick`。**分流规则不在这里** —— 点下去只把 url 交给调用方
 * （`ui/ChatDetail.ets` 的 `openChatLink`），由它按 `core/ChatLinkTarget.ts` 的判断决定
 * 是开文件、开浏览器，还是明确告知不支持。
 *
 * ## 为什么用 `Span` + `Text()` 而不是 `StyledString` 或 `Text(text, { gesture })`
 *
 * 需要的是「同一段文字里，只有链接那几段能点」。`StyledString` + `GestureStyle` 也能做，
 * 但那是另一套排版模型（组件属性作基准、span 覆盖），字号 / 行高 / 颜色的表现要重新摸；
 * `Span` + `Text()` 是本工程已经在用的写法（`ui/MarkdownView.ets` 的代码块高亮就是它），
 * 行为已知。代价见下一节。
 *
 * ## 样式为什么要按处传（而不是继承父级）
 *
 * `Span` 只能设「文字样式」类属性，字号 / 行高 / 颜色这些**文本属性必须设在 `Text` 上**；
 * 而 `Text` 的属性又没法以「通用属性」的形式从调用处传进自定义组件 ——
 * 自定义组件的通用属性只会作用到它自己的根节点上（本组件就是靠这一条把底色 / 内边距
 * 交给调用方，见 `ui/ChatMessage.ets` 用户气泡那一处），但 `fontSize` 不是通用属性。
 * 所以字号它们只能是入参。
 *
 * 由此有一条必须记住的联动：**改了 `ui/MarkdownView.ets` 里某一处的字号 / 行高，
 * 必须同步改这里传进来的值**，否则那一段的字号会与同一份排版里的其它段不一致。
 *
 * ## 行高为 0 时为什么另走一个分支（而不是传个"默认值"）
 *
 * 标题 / 列表 / 引用块原本**没有设过行高**（用字体默认行距），正文段落才显式设了
 * `21 × 缩放`。ArkUI 的属性链没法「有条件地少设一个属性」，而我又不愿给它们随便塞一个
 * 数值（默认行距是字体度量决定的，猜一个必然把标题的行距改样）。所以 `lineHeight > 0`
 * 时才设它 —— 代价是 `build()` 里有两条几乎相同的链，这是**有意为之**，不是漏改写。
 *
 * ## 为什么**不**在组件内部写死 `width('100%')`
 *
 * 用户气泡那一处的宽度是**贴着文字**的（原始写法就是一个不带宽度的 `Text`，
 * 底色由文字自己背）。若在这里统一设 `width('100%')`，那个 `Text` 会去撑满父容器，
 * 用户消息就会变成一条整宽的色带 —— 版式事故。所以本组件不自带宽度，
 * 由调用方按处决定：正文段落 / 标题照旧 `width('100%')`，气泡不设。
 *
 * ## 表格单元格故意不换
 *
 * `ui/MarkdownView.ets` 的表格单元格仍走 `Text(inlineMarkup(cell))`：列宽是按
 * **剥壳后的文字**估出来的（`markdownTableColumnWidths`），换成可点链接会让估宽与呈现
 * 两套口径；而表格里出现会话文件名的概率远低于正文。这是有意的取舍，不是漏掉。
 */

import { InlineKind, InlineSegment, inlineSegments } from '../core/InlineSegments';

@Component
export struct InlineText {
  /** 要渲染的原始文本（可能带 Markdown 标记，也可能带 `[文字](目标)`）。 */
  text: string = '';
  fontSize: number = 14;
  fontWeight: FontWeight = FontWeight.Normal;
  /**
   * 行高（vp）。**`0` 表示不设**，用字体默认行距 —— 标题 / 列表 / 引用块原本就是这样，
   * 只有正文段落需要 `21 × 缩放`。理由见文件头。
   */
  lineHeight: number = 0;
  /** 是否用次级色（引用块用）。默认主色，与正文 / 用户气泡一致。 */
  secondary: boolean = false;
  /** 点链接：只把目标递出去，怎么开由调用方决定。 */
  onLink: (url: string) => void = (): void => {};

  private textColor(): Resource {
    return this.secondary
      ? $r('sys.color.ohos_id_color_text_secondary')
      : $r('sys.color.ohos_id_color_text_primary');
  }

  /**
   * 链接的配色。
   *
   * 用**系统色**而不是写死一个蓝色：应用有浅色 / 深色 / 跟随系统三档主题，
   * 系统色会跟着换；写死一套在深色模式下必然有一头读不清 ——
   * 与 `ui/MarkdownView.ets` 代码块高亮同一条理由（那里也是全系统色）。
   *
   * 链接还要带**下划线**：只换颜色的话，浅色主题下的"激活蓝"与正文灰对比不够，
   * 「这一段能点」这个信息就丢了。
   */
  private linkColor(): Resource {
    return $r('sys.color.ohos_id_color_text_primary_activated');
  }

  /**
   * 一段文字的下划线样式。
   *
   * 写成方法（而不是在属性里塞三元表达式）是因为这里要按有无 `color` 分两种形态：
   * ArkTS 对**对象字面量**的类型推断很严，写在实参位置的 `{ type, color }` 容易报
   * 「缺少类型标注」；放到方法里就能显式标 `DecorationStyleInterface`。
   * 普通文字也得显式给 `None`：`Text` 上没设过 decoration，但代码块里同一个 `Text`
   * 可能被别处复用，**显式声明比依赖缺省值稳**。
   */
  private decorationOf(segment: InlineSegment): DecorationStyleInterface {
    const isLink: boolean = segment.kind === InlineKind.LINK;
    const decoration: DecorationStyleInterface = {
      type: isLink ? TextDecorationType.Underline : TextDecorationType.None,
    };
    if (isLink) {
      decoration.color = this.linkColor();
    }
    return decoration;
  }

  /**
   * 每段的文字样式。
   *
   * `ForEach` 里**不能写 `if/else`**：`Text` 的子节点只接受 `Span`（`ImageSpan` 之类），
   * 而条件渲染生成的是条件节点、不是 `Span`，`Text` 的排版碰到它必然出问题。
   * 所以「链接 / 普通」的差别全部落到**属性值**上（颜色用三元、下划线用方法），
   * 节点本身只有一个 `Span`。同理，点击回调挂在每一段上、由回调内部自己判是不是链接 ——
   * 普通段点了什么也不会发生。
   */
  private spanKey(segment: InlineSegment, index: number): string {
    return `${index}:${segment.kind}:${segment.text}`;
  }

  build() {
    if (this.lineHeight > 0) {
      Text() {
        ForEach(inlineSegments(this.text), (segment: InlineSegment, index: number) => {
          Span(segment.text)
            .fontColor(segment.kind === InlineKind.LINK ? this.linkColor() : this.textColor())
            .decoration(this.decorationOf(segment))
            .onClick((): void => {
              if (segment.kind === InlineKind.LINK) {
                this.onLink(segment.url);
              }
            })
        }, (segment: InlineSegment, index: number) => this.spanKey(segment, index))
      }
      .fontSize(this.fontSize)
      .lineHeight(this.lineHeight)
      .fontWeight(this.fontWeight)
      .fontColor(this.textColor())
      .copyOption(CopyOptions.LocalDevice)
    } else {
      Text() {
        ForEach(inlineSegments(this.text), (segment: InlineSegment, index: number) => {
          Span(segment.text)
            .fontColor(segment.kind === InlineKind.LINK ? this.linkColor() : this.textColor())
            .decoration(this.decorationOf(segment))
            .onClick((): void => {
              if (segment.kind === InlineKind.LINK) {
                this.onLink(segment.url);
              }
            })
        }, (segment: InlineSegment, index: number) => this.spanKey(segment, index))
      }
      .fontSize(this.fontSize)
      .fontWeight(this.fontWeight)
      .fontColor(this.textColor())
      .copyOption(CopyOptions.LocalDevice)
    }
  }
}
