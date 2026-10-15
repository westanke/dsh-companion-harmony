/**
 * 聊天消息的渲染 —— 移植自原工程 `ui/ChatScreen.kt` 里从 `ChatItem` 到 `ToolTextBlock`
 * 那一整段（约 2430–3050 行）。
 *
 * ## 与源工程的对应关系
 *
 * | 源工程 | 本文件 |
 * |---|---|
 * | `ChatItem` | `ChatMessageView` |
 * | `AssistantBody` + `Markdown` | `AssistantBody` + `MarkdownView` + `GenUiSegment` |
 * | `GenUiDebugLine` | `GenUiDebugLine` |
 * | `MessageAttachments` / `AttachmentNotice` | `MessageAttachments` / `AttachmentImage` |
 * | `TurnFailureRow` | `TurnFailureRow` |
 * | `ActivityRow` | `ActivityRow` |
 * | `ToolCallDetailBlock` / `ToolTextBlock` | 同名 |
 *
 * ## 三处必须说明的平台差异
 *
 * 1. **Markdown 渲染器是自备的**（`core/MarkdownLite.ts`）。源工程用
 *    `com.mikepenz.markdown.m3`，那是 Android 专有库；ArkUI 没有等价物。
 *    所以这里只做块级排版（标题 / 列表 / 引用 / 代码 / **表格** / 分隔线 / 段落），
 *    行内标记统一由 `inlineMarkup` 剥掉。表格从「不画」改成「画」见下方第 4 条。
 * 2. **图片要先解码**（`platform/ImageCodec.ets`）。ArkUI 的 `Image()` 不接受原始字节，
 *    只认 `PixelMap`；解码放在 `AttachmentImage.aboutToAppear`，解不出来就显示
 *    「这张图片无法显示」（对应源工程 `BitmapFactory` 返回 null 的那一支）。
 * 3. **复制手势用双击**，与源工程一字不差。源工程的注释里记了一次翻车：早期给整条消息
 *    挂 `onLongClick`，长按被外层吃掉，`SelectionContainer` 的选择手柄永远弹不出来。
 *    ArkUI 这边同理 —— 文本选择靠 `copyOption(CopyOptions.LocalDevice)`（长按触发），
 *    所以外层**只能**声明双击手势，绝不能声明长按。
 * 4. **表格要横向滚、列宽要自己定**（`MarkdownView.tableView`）。ArkUI 的 `Scroll`
 *    只支持单方向，所以横向滚动**只加在最外层** —— 套在表格外面，列宽才不会被
 *    无界宽度约束带偏（dsh-ui 卡片那边踩过同一个坑，见 `GenUiCard` 文件头第 1 条）。
 *    列宽由 `markdownTableColumnWidths` 按内容估，估出来的宽度被 `width()` 定死。
 *
 * ## 三处照抄源工程、不许简化的判据
 *
 * 1. **用户消息的文字可以为空**（只发图不打字是正常用法），所以判空只挡文字气泡、
 *    不挡附件渲染。
 * 2. **工具行的「把失败显示在折叠态」**：用户点开详情最主要的理由就是「刚才那条命令
 *    报了什么错」，所以 `failed` 时折叠态也要有红色「失败」两字与感叹号图标。
 * 3. **`tool.result == null` 与 `tool.result == ""` 是两种状态**（还没有结果 / 结果为空），
 *    文案不同，不能合并成一个分支。
 */

import {
  ChatAttachment, ChatDisplayItem, ChatItemKind, ChatTurnFailure, formatToolDuration,
  prettyToolArguments, ToolCallDetail,
} from '../core/ChatPresentation';
import { GenUiDiagnosis, diagnoseGenUi, GenUiSpec, inlineMarkup, MessageSegment, MessageSegmentKind,
  parseGenUi, splitMessageBody } from '../core/GenUiBlocks';
import { MARKDOWN_TABLE_MIN_COLUMN_VP, markdownTableColumnWidths, MdBlock, MdBlockKind, MdTable,
  markdownBlocks } from '../core/MarkdownLite';
import { localizedErrorText } from '../core/ErrorMessages';
import { GenUiCard } from './GenUiCard';
import { writeClipboardText } from '../platform/Clipboard';
import { decodeImageSync } from '../platform/ImageCodec';
import { systemLanguageTag } from '../platform/Platform';

/** 助手正文的最大宽度（vp）：对位源工程的 `widthIn(max = 720.dp)`。 */
const ASSISTANT_MAX_WIDTH_VP: number = 720;

/** 用户气泡占屏宽的比例：对位 `fillMaxWidth(0.78f)`。 */
const USER_BUBBLE_WIDTH: string = '78%';

/**
 * 极简 Markdown 渲染（块级）。
 *
 * 字号对照源工程 `compactMarkdownTypography()`：h1 到 h6 逐级递减，
 * 正文用 14（对应 `bodyMedium`），代码用 12 加等宽字体。
 *
 * `textScale` 供「文件」页用：那里的 Markdown 预览要跟着文字缩放按钮一起变
 * （源工程 `fileMarkdownTypography(scale)` 把每一档字号都乘上缩放系数）。
 * 聊天正文里一律保持 1。
 *
 * 字段名刻意不叫 `scale`：`scale` 是 ArkUI 自定义组件的通用属性方法名
 * （见 PORT-MAP §1b 坑 7），字段同名会被判类型冲突。
 */
@Component
export struct MarkdownView {
  body: string = '';
  textScale: number = 1;

  private blocks(): MdBlock[] {
    return markdownBlocks(this.body);
  }

  /** 按缩放系数换算字号；`textScale == 1` 时就是源工程聊天正文的那套字号。 */
  private scaled(size: number): number {
    return size * this.textScale;
  }

  /** 标题字号：1→22 / 2→19 / 3→17 / 4→15 / 5、6→14。 */
  private headingSize(level: number): number {
    if (level === 1) {
      return this.scaled(22);
    }
    if (level === 2) {
      return this.scaled(19);
    }
    if (level === 3) {
      return this.scaled(17);
    }
    if (level === 4) {
      return this.scaled(15);
    }
    return this.scaled(14);
  }

  /** 正文单元格字号（也是列宽估算的基准字号）。 */
  private cellSize(): number {
    return this.scaled(13);
  }

  /**
   * 表头单元格字号（比正文大一号）。
   *
   * 渲染与列宽估算**共用这一个出处** —— 之前这里写死 14、估算却按正文的 13 算，
   * 两处各写各的，长表头因此被折断。以后改字号只动这里。
   */
  private headerCellSize(): number {
    return this.scaled(14);
  }

  /**
   * 各列宽度（vp）。**先过 `inlineMarkup` 再估** —— 见 `markdownTableColumnWidths` 的注释：
   * 表格里 `[文字](很长的链接)` 很常见，不剥标记的话链接长度会把列宽直接顶到上限。
   */
  private columnWidthsOf(table: MdTable): number[] {
    const header: string[] = [];
    for (let i = 0; i < table.header.length; i++) {
      header.push(inlineMarkup(table.header[i]));
    }
    const rows: string[][] = [];
    for (let r = 0; r < table.rows.length; r++) {
      const cells: string[] = table.rows[r];
      const stripped: string[] = [];
      for (let c = 0; c < cells.length; c++) {
        stripped.push(inlineMarkup(cells[c]));
      }
      rows.push(stripped);
    }
    return markdownTableColumnWidths(header, rows, this.cellSize(), this.headerCellSize());
  }

  private columnWidthAt(table: MdTable, index: number): number {
    const widths: number[] = this.columnWidthsOf(table);
    return index < widths.length ? widths[index] : MARKDOWN_TABLE_MIN_COLUMN_VP;
  }

  /** 整张表的宽度：横向滚动的子级必须显式给宽，否则无界约束下会塌掉。 */
  private tableWidthOf(table: MdTable): number {
    const widths: number[] = this.columnWidthsOf(table);
    let total: number = 0;
    for (let i = 0; i < widths.length; i++) {
      total += widths[i];
    }
    return total;
  }

  /**
   * `ForEach` 的键。
   *
   * 表格的 `text` 是空串（内容在 `table` 里），只按 `长度` 编键会让流式更新期间键不变、
   * 组件不重建 —— 表格就一直停在第一帧。所以表格要把表头与各行的实际文字编进键里。
   */
  private keyOf(block: MdBlock, index: number): string {
    if (block.kind === MdBlockKind.TABLE && block.table !== null) {
      const table: MdTable = block.table;
      const parts: string[] = [table.header.join('~')];
      for (let r = 0; r < table.rows.length; r++) {
        parts.push(table.rows[r].join('~'));
      }
      return `${index}:TABLE:${parts.join('#')}`;
    }
    return `${index}:${block.kind}:${block.text.length}`;
  }

  @Builder
  tableView(table: MdTable) {
    // 横向滚动只加在最外层（见文件头平台差异 4）。
    Scroll() {
      Column() {
        Row() {
          ForEach(table.header, (cell: string, columnIndex: number) => {
            Text(inlineMarkup(cell))
              .fontSize(this.headerCellSize())
              .fontWeight(FontWeight.Medium)
              .width(this.columnWidthAt(table, columnIndex))
              .padding(8)
          }, (cell: string, columnIndex: number) => `th-${columnIndex}-${cell}`)
        }
        .width(this.tableWidthOf(table))
        .backgroundColor($r('sys.color.ohos_id_color_sub_background'))

        // 宽度必须显式给：横向滚动的子级拿到的是**无界**宽度约束，
        // Divider 默认铺满 —— 无界下会塌成 0 宽，这条线整个不见。
        Divider()
          .strokeWidth(1)
          .width(this.tableWidthOf(table))
          .color($r('sys.color.ohos_id_color_list_separator'))

        ForEach(table.rows, (cells: string[], rowIndex: number) => {
          Row() {
            ForEach(table.header, (column: string, columnIndex: number) => {
              Text(columnIndex < cells.length ? inlineMarkup(cells[columnIndex]) : '')
                .fontSize(this.cellSize())
                .width(this.columnWidthAt(table, columnIndex))
                .padding(8)
            }, (column: string, columnIndex: number) => `td-${rowIndex}-${columnIndex}`)
          }
          .width(this.tableWidthOf(table))
        }, (cells: string[], rowIndex: number) => `tr-${rowIndex}-${cells.length}`)
      }
      .alignItems(HorizontalAlign.Start)
    }
    .scrollable(ScrollDirection.Horizontal)
    .width('100%')
    .align(Alignment.TopStart)
    .margin({ top: 4, bottom: 6 })
  }

  @Builder
  blockView(block: MdBlock, index: number) {
    if (block.kind === MdBlockKind.HEADING) {
      Text(inlineMarkup(block.text))
        .fontSize(this.headingSize(block.level))
        .fontWeight(block.level <= 3 ? FontWeight.Bold : FontWeight.Medium)
        .width('100%')
        .margin({ top: 8, bottom: 2 })
        .copyOption(CopyOptions.LocalDevice)
    } else if (block.kind === MdBlockKind.BULLET) {
      Row() {
        Text('•')
          .fontSize(this.scaled(14))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text(inlineMarkup(block.text))
          .fontSize(this.scaled(14))
          .layoutWeight(1)
          .margin({ left: 6 })
          .copyOption(CopyOptions.LocalDevice)
      }
      .width('100%')
      .padding({ left: 8 })
      .alignItems(VerticalAlign.Top)
    } else if (block.kind === MdBlockKind.ORDERED) {
      Row() {
        Text(`${block.ordinal}.`)
          .fontSize(this.scaled(14))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width(22)
        Text(inlineMarkup(block.text))
          .fontSize(this.scaled(14))
          .layoutWeight(1)
          .copyOption(CopyOptions.LocalDevice)
      }
      .width('100%')
      .padding({ left: 8 })
      .alignItems(VerticalAlign.Top)
    } else if (block.kind === MdBlockKind.QUOTE) {
      // 引用用左边一条竖线表示：ArkUI 没有 borderLeft 这种单边语法以外的写法，
      // 用「Row 里放 3vp 宽的色块」最直观，也避开了 .border 在小圆角下的边角怪相。
      Row() {
        Column()
          .width(3)
          .alignSelf(ItemAlign.Stretch)
          .backgroundColor($r('sys.color.ohos_id_color_emphasize'))
        Text(inlineMarkup(block.text))
          .fontSize(this.scaled(14))
          .layoutWeight(1)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ left: 8 })
          .copyOption(CopyOptions.LocalDevice)
      }
      .width('100%')
      .padding({ top: 2, bottom: 2 })
    } else if (block.kind === MdBlockKind.CODE) {
      // 横向 Scroll 包一层：终端输出与 diff 经常是「很宽的一行 + 很多行」，
      // 硬折行会把缩进层次全打乱。
      Scroll() {
        Text(block.text)
          .fontSize(this.scaled(12))
          .fontFamily('monospace')
          .padding(8)
          .copyOption(CopyOptions.LocalDevice)
      }
      .scrollable(ScrollDirection.Horizontal)
      .width('100%')
      .borderRadius(6)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    } else if (block.kind === MdBlockKind.TABLE) {
      if (block.table !== null) {
        this.tableView(block.table as MdTable)
      }
    } else if (block.kind === MdBlockKind.HR) {
      // 分隔线：整行一条细线，不用 Divider 的默认整屏铺满，留一点左右边距更像一条「线」。
      Divider()
        .strokeWidth(1)
        .color($r('sys.color.ohos_id_color_list_separator'))
        .width('100%')
        .margin({ top: 8, bottom: 8 })
    } else {
      Text(inlineMarkup(block.text))
        .fontSize(this.scaled(14))
        .lineHeight(this.scaled(21))
        .width('100%')
        .copyOption(CopyOptions.LocalDevice)
    }
  }

  build() {
    Column() {
      ForEach(this.blocks(), (block: MdBlock, index: number) => {
        this.blockView(block, index)
      }, (block: MdBlock, index: number) => this.keyOf(block, index))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 一个 dsh-ui 片段。
 *
 * 单独成一个组件而不是内联在 `AssistantBody` 里，是为了让「解析一次」这件事落在
 * `aboutToAppear` 上：`@Builder` 里不能声明局部变量，写在表达式里就得解析两遍
 * （一次判空、一次传参）。
 */
@Component
struct GenUiSegment {
  json: string = '';
  onAnswer: (text: string) => void = (): void => {};

  @State spec: GenUiSpec | null = null;

  aboutToAppear(): void {
    this.spec = parseGenUi(this.json);
  }

  build() {
    Column() {
      if (this.spec !== null) {
        GenUiCard({ spec: this.spec as GenUiSpec, onAnswer: this.onAnswer })
      } else {
        // 解析失败不吞内容：回落成代码块，用户至少还能看到原文（与源工程一致）。
        MarkdownView({ body: `\`\`\`json\n${this.json}\n\`\`\`` })
      }
    }
    .width('100%')
  }
}

/**
 * dsh-ui 诊断行（只在设置里打开开关时出现）。
 *
 * 点一下在「摘要 / 全文」之间切换：一行灰字塞不下全部信息，但用户截图发回来就够了，
 * 所以摘要页也必须能展开 —— 否则最关键的那句报错会被截断掉，等于白测。
 */
@Component
export struct GenUiDebugLine {
  diagnosis: GenUiDiagnosis = new GenUiDiagnosis('', '');

  @State expanded: boolean = false;

  private copyAll(): void {
    writeClipboardText(this.diagnosis.details);
    this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copied') });
  }

  build() {
    Column() {
      Text(this.diagnosis.summary)
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
      if (this.expanded) {
        Text(this.diagnosis.details)
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: 2 })
          .width('100%')
          .copyOption(CopyOptions.LocalDevice)
      }
    }
    .width('100%')
    .margin({ top: 4 })
    .onClick((): void => {
      this.expanded = !this.expanded;
    })
    .gesture(GestureGroup(GestureMode.Parallel, LongPressGesture().onAction((): void => {
      this.copyAll();
    })))
  }
}

/** 助手正文：文字走 Markdown，卡片走原生组件（见文件头平台差异 1）。 */
@Component
struct AssistantBody {
  body: string = '';
  streaming: boolean = false;
  genUiDebug: boolean = false;
  onAnswer: (text: string) => void = (): void => {};

  private segments(): MessageSegment[] {
    return splitMessageBody(this.body);
  }

  /** 全是散文（没有卡片）时走单块 Markdown，少一层 ForEach 嵌套。 */
  private isPlain(): boolean {
    const list: MessageSegment[] = this.segments();
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === MessageSegmentKind.UI) {
        return false;
      }
    }
    return true;
  }

  /** 诊断独立于渲染分支算：只有这样才能暴露「解析器说成功、屏幕上却没有卡片」这种不一致。 */
  private diagnosis(): GenUiDiagnosis | null {
    return this.genUiDebug ? diagnoseGenUi(this.body) : null;
  }

  @Builder
  segmentView(segment: MessageSegment) {
    if (segment.kind === MessageSegmentKind.UI) {
      GenUiSegment({ json: segment.text, onAnswer: this.onAnswer })
    } else {
      MarkdownView({ body: segment.text })
    }
  }

  build() {
    Column() {
      if (this.isPlain()) {
        MarkdownView({ body: this.body })
        if (this.diagnosis() !== null) {
          GenUiDebugLine({ diagnosis: this.diagnosis() as GenUiDiagnosis })
        }
      } else {
        ForEach(this.segments(), (segment: MessageSegment, index: number) => {
          this.segmentView(segment)
        }, (segment: MessageSegment, index: number) => `${index}:${segment.kind}`)
        if (this.diagnosis() !== null) {
          GenUiDebugLine({ diagnosis: this.diagnosis() as GenUiDiagnosis })
        }
      }
    }
    .width('100%')
    .constraintSize({ maxWidth: ASSISTANT_MAX_WIDTH_VP })
    .padding({ left: 2, right: 2, top: 2, bottom: 2 })
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 一张会话图片。
 *
 * 三态是刻意的：**下载中**显示占位、**失败**显示可读的原因、**成功**显示图片。
 * 少了中间态，慢网络下用户会以为图丢了；把失败也当成「还在加载」，用户会一直等下去。
 *
 * 解码失败（字节取到了但不是有效图片）单独区分：那说明数据有问题，与网络无关，
 * 提示也不该让用户去重试网络。
 */
@Component
struct AttachmentImage {
  attachmentId: string = '';
  bytes: Uint8Array | null = null;
  mediaType: string = '';
  failure: string | null = null;
  onLoad: (id: string) => void = (): void => {};

  @State pixelMap: PixelMap | null = null;

  aboutToAppear(): void {
    if (this.bytes !== null) {
      this.pixelMap = decodeImageSync(this.bytes);
      return;
    }
    // 还没有字节也没有失败 → 请求一次。`HarnessViewModel.loadAttachmentImage` 自带
    // 「已经在读」「已经拿到」「已经记死失败」三重闸，重复调用不会打穿服务端。
    if (this.failure === null) {
      this.onLoad(this.attachmentId);
    }
  }

  build() {
    Column() {
      if (this.pixelMap !== null) {
        Image(this.pixelMap)
          .objectFit(ImageFit.Contain)
          .constraintSize({ maxWidth: 260, maxHeight: 340 })
          .borderRadius(8)
      } else if (this.bytes !== null) {
        Text($r('app.string.attachment_undecodable'))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      } else if (this.failure !== null) {
        Text(this.failure)
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .constraintSize({ maxWidth: 260 })
      } else {
        Column() {
          LoadingProgress()
            .width(20)
            .height(20)
            .color($r('sys.color.ohos_id_color_text_secondary'))
        }
        .width(88)
        .height(88)
        .borderRadius(6)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .justifyContent(FlexAlign.Center)
      }
    }
    .alignItems(HorizontalAlign.End)
  }
}

/** 一条消息附带的图片列表。 */
@Component
struct MessageAttachments {
  attachments: ChatAttachment[] = [];
  /** 已取到的字节，按 attachmentId 索引。 */
  images: Map<string, Uint8Array> = new Map();
  /** 取图失败的原因（已本地化），按 attachmentId 索引。 */
  failures: Map<string, string> = new Map();
  onLoadImage: (id: string) => void = (): void => {};

  private bytesOf(id: string): Uint8Array | null {
    const found: Uint8Array | undefined = this.images.get(id);
    return found === undefined ? null : found;
  }

  private failureOf(id: string): string | null {
    const found: string | undefined = this.failures.get(id);
    return found === undefined ? null : found;
  }

  /**
   * ForEach 的键必须把「拿到字节 / 记下失败」也编进去。
   *
   * 只用 `attachmentId` 当键的话，字节到达时键不变，ArkUI 会**跳过**该子组件的重建，
   * 于是图片永远显示成加载中 —— 这是本页最容易踩、且看起来最像「后端没返回」的一个坑。
   */
  private keyOf(id: string): string {
    if (this.images.has(id)) {
      return `${id}:bytes`;
    }
    if (this.failures.has(id)) {
      return `${id}:fail`;
    }
    return `${id}:loading`;
  }

  build() {
    Column() {
      if (this.attachments.length > 0) {
        ForEach(this.attachments, (attachment: ChatAttachment) => {
          AttachmentImage({
            attachmentId: attachment.attachmentId,
            bytes: this.bytesOf(attachment.attachmentId),
            mediaType: attachment.mediaType,
            failure: this.failureOf(attachment.attachmentId),
            onLoad: this.onLoadImage,
          })
        }, (attachment: ChatAttachment) => this.keyOf(attachment.attachmentId))
      }
    }
    .width('100%')
    .margin({ top: 4 })
    .alignItems(HorizontalAlign.End)
  }
}

/**
 * 一轮模型运行的终局失败行（源工程 `TurnFailureRow`）。
 *
 * 三行信息各自有用，缺一行就得靠猜：
 * - 标题：「本轮运行失败」/「任务已停止」（后者是登出，不是模型故障）；
 * - 正文：服务端的原话（429 限流那句话就在这里）；命中本地错误码表时换成中文句子；
 * - 错误码：**照原样显示，空串也占位**（行高不忽高忽低）。
 */
@Component
struct TurnFailureRow {
  failure: ChatTurnFailure = new ChatTurnFailure();

  private headline(): ResourceStr {
    return this.failure.stopped ? $r('app.string.turn_stopped_title') : $r('app.string.turn_failed_title');
  }

  /**
   * 正文：命中错误码表就用本地化句子，否则退回内核原文（英文，但至少是信息，也方便贴给开发者）。
   *
   * 与源工程一致：**标题与正文都不写死在数据层** —— 那里以前写死中文，英文界面下照样弹中文。
   */
  private detail(): string {
    const localized: string | null = localizedErrorText(this.failure.code, systemLanguageTag());
    return localized === null ? this.failure.message : localized;
  }

  /**
   * 复制的是**内容**而不是标题：用户把这段贴给别人时，标题（「本轮运行失败」）
   * 不含任何信息，一句服务端原话加上错误码才是现场。所以标题行不进来。
   */
  private copyAll(): void {
    const lines: string[] = [];
    if (this.detail().length > 0) {
      lines.push(this.detail());
    }
    if (this.failure.code !== null && this.failure.code.length > 0) {
      lines.push(this.failure.code);
    }
    writeClipboardText(lines.join('\n'));
    this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copied') });
  }

  build() {
    Column() {
      Row() {
        Text('⚠')
          .fontSize(16)
          .fontColor($r('sys.color.ohos_id_color_alert'))
        Text(this.headline())
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_alert'))
          .margin({ left: 7 })
        if (this.failure.code !== null && this.failure.code.length > 0) {
          Text(this.failure.code)
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ left: 6 })
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.detail().length > 0) {
        Text(this.detail())
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 2 })
          .copyOption(CopyOptions.LocalDevice)
      }
    }
    .width('100%')
    .padding({ left: 4, right: 4, top: 4, bottom: 4 })
    .alignItems(HorizontalAlign.Start)
    .gesture(GestureGroup(GestureMode.Parallel, LongPressGesture().onAction((): void => {
      this.copyAll();
    })))
  }
}

/**
 * 一段可滚动、可复制、等宽显示的工具文本（输入或输出）。
 *
 * 两个轴都要能滚：终端输出经常是「很宽的一行 + 很多行」，只给纵向滚动的话宽行会被
 * 硬折行，缩进层次就全乱了。ArkUI 的一个 `Scroll` 只支持单方向，所以纵向套横向。
 */
@Component
struct ToolTextBlock {
  label: ResourceStr = '';
  text: string = '';
  isError: boolean = false;
  maxHeightVp: number = 160;

  private accent(): ResourceStr {
    return this.isError ? $r('sys.color.ohos_id_color_alert') : $r('sys.color.ohos_id_color_list_separator');
  }

  private copy(): void {
    writeClipboardText(this.text);
    this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copied') });
  }

  build() {
    Column() {
      Row() {
        Text(this.label)
          .fontSize(11)
          .fontWeight(this.isError ? FontWeight.Medium : FontWeight.Normal)
          .fontColor(this.isError
            ? $r('sys.color.ohos_id_color_alert')
            : $r('sys.color.ohos_id_color_text_secondary'))
          .layoutWeight(1)
        Text($r('app.string.tool_detail_copy'))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .onClick((): void => {
            this.copy();
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Scroll() {
        Scroll() {
          Text(this.text)
            .fontSize(12)
            .fontFamily('monospace')
            .fontColor(this.isError
              ? $r('sys.color.ohos_id_color_alert')
              : $r('sys.color.ohos_id_color_text_primary'))
            .copyOption(CopyOptions.LocalDevice)
        }
        .scrollable(ScrollDirection.Horizontal)
      }
      .width('100%')
      .align(Alignment.TopStart)
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 6, bottom: 6 })
    .borderRadius(6)
    .border({ width: 1, color: this.accent() })
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .constraintSize({ maxHeight: this.maxHeightVp })
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 一条工具调用的详情块：工具名 + 状态 + 耗时，然后是完整输入与完整输出。
 *
 * 数据全部来自 `ChatDisplayItem.tools`。输入是内核原样的 `arguments` 字符串（缩进后显示），
 * 输出是 `tool/result` 的 content 里 text 段拼起来的结果。两者都能一键复制 ——
 * 手机上开不了终端，把这段输出复制出来发给自己，是唯一能把现场带走的办法。
 */
@Component
struct ToolCallDetailBlock {
  tool: ToolCallDetail = new ToolCallDetail();

  private statusText(): ResourceStr {
    if (this.tool.result === null) {
      return $r('app.string.tool_detail_pending');
    }
    return this.tool.failed ? $r('app.string.tool_detail_failed') : $r('app.string.tool_detail_ok');
  }

  private statusColor(): ResourceStr {
    if (this.tool.failed) {
      return $r('sys.color.ohos_id_color_alert');
    }
    return this.tool.result === null
      ? $r('sys.color.ohos_id_color_text_secondary')
      : $r('sys.color.ohos_id_color_text_primary_activated');
  }

  private nameText(): string {
    return this.tool.name.trim().length > 0 ? this.tool.name : '';
  }

  private argumentsText(): string {
    return prettyToolArguments(this.tool.argumentsJson);
  }

  private durationText(): string {
    const duration: number | null = this.tool.durationMs;
    // 算不出来就没有这一行（不显示 0、也不显示负数）。
    return duration === null ? '' : formatToolDuration(duration);
  }

  @Builder
  resultBlock() {
    if (this.tool.result === null) {
      Text($r('app.string.tool_detail_no_result'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    } else if (this.tool.result.length === 0) {
      Text($r('app.string.tool_detail_empty_result'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    } else {
      ToolTextBlock({
        label: this.tool.failed ? $r('app.string.tool_detail_error') : $r('app.string.tool_detail_output'),
        text: this.tool.result,
        isError: this.tool.failed,
        maxHeightVp: 260,
      })
    }
  }

  build() {
    Column() {
      Row() {
        if (this.nameText().length > 0) {
          Text(this.nameText())
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontFamily('monospace')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        } else {
          Text($r('app.string.tool_call'))
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .layoutWeight(1)
        }
        if (this.durationText().length > 0) {
          Text(this.durationText())
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ right: 8 })
        }
        Text(this.statusText())
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.statusColor())
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.argumentsText().length === 0) {
        Text($r('app.string.tool_detail_no_args'))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      } else {
        ToolTextBlock({
          label: $r('app.string.tool_detail_input'),
          text: this.argumentsText(),
          isError: false,
          maxHeightVp: 160,
        })
      }

      this.resultBlock()
    }
    .width('100%')
    .margin({ top: 6 })
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 活动行（上下文注入 / 思考 / 工具调用）。
 *
 * 展开判据照抄源工程：
 * - 有逐条明细（`tools` 非空）**一定**可展开 —— 这就是「工具调用详情」的入口；
 * - 工具行在合并成一组（`body` 里含换行）之后也要能展开；单次调用的那一行没什么可展的，
 *   展开反而是噪音。
 *
 * `REASONING` 这条分支现在只是兜底：历史与流式两处都已把思考挡在消息流之外，
 * 改由底部思考条承载。万一哪天漏进来一条，至少还显示得出来，而不是变成一行空白。
 */
@Component
struct ActivityRow {
  item: ChatDisplayItem = new ChatDisplayItem('', 0, ChatItemKind.TOOL);
  onAnswer: (text: string) => void = (): void => {};

  @State expanded: boolean = false;

  private multiTool(): boolean {
    return this.item.kind === ChatItemKind.TOOL && this.item.body.includes('\n');
  }

  private expandable(): boolean {
    if (this.item.tools.length > 0) {
      return true;
    }
    if (this.item.body.length === 0) {
      return false;
    }
    return this.item.kind !== ChatItemKind.TOOL || this.multiTool();
  }

  private labelRes(): ResourceStr {
    if (this.item.kind === ChatItemKind.CONTEXT) {
      return $r('app.string.context_injection');
    }
    if (this.item.kind === ChatItemKind.REASONING) {
      return $r('app.string.think');
    }
    if (this.item.kind === ChatItemKind.TOOL) {
      const title: string | null = this.item.title;
      return title === null ? $r('app.string.tool_call') : title;
    }
    return '';
  }

  private iconText(): string {
    if (this.item.kind === ChatItemKind.CONTEXT) {
      return '📄';
    }
    if (this.item.kind === ChatItemKind.REASONING) {
      return '🧠';
    }
    return '🔧';
  }

  /** 失败的工具**不展开也要看得见**（源工程 `item.tools.any { it.failed }`）。 */
  private failed(): boolean {
    for (let i = 0; i < this.item.tools.length; i++) {
      if (this.item.tools[i].failed) {
        return true;
      }
    }
    return false;
  }

  /**
   * 折叠时的预览：优先用正文首行；正文为空（例如只有参数的调用）就退回工具名，
   * 否则这一行看起来像空条目。
   */
  private preview(): string {
    const newline: number = this.item.body.indexOf('\n');
    const first: string = newline < 0 ? this.item.body : this.item.body.substring(0, newline);
    if (first.trim().length > 0) {
      return first;
    }
    const names: string[] = [];
    for (let i = 0; i < this.item.tools.length; i++) {
      const name: string = this.item.tools[i].name.trim();
      names.push(name.length > 0 ? name : 'tool');
    }
    return names.join('，');
  }

  /** 上下文行额外显示标题：` · title`（源工程 `item.title.takeIf { kind == CONTEXT }`）。 */
  private contextTitleSuffix(): string {
    if (this.item.kind !== ChatItemKind.CONTEXT || this.item.title === null) {
      return '';
    }
    return ` · ${this.item.title}`;
  }

  @Builder
  detailBlocks() {
    if (this.item.tools.length > 0) {
      Column() {
        ForEach(this.item.tools, (tool: ToolCallDetail, index: number) => {
          if (index > 0) {
            Divider()
              .strokeWidth(1)
              .color($r('sys.color.ohos_id_color_list_separator'))
              .margin({ top: 8, bottom: 8 })
          }
          ToolCallDetailBlock({ tool: tool })
        }, (tool: ToolCallDetail, index: number) => `${index}:${tool.callId}`)
      }
      .width('100%')
      .padding({ left: 27, right: 6, bottom: 8 })
      .alignItems(HorizontalAlign.Start)
    } else {
      Column() {
        MarkdownView({ body: this.item.body })
      }
      .width('100%')
      .padding({ left: 27, right: 6, bottom: 8 })
      .alignItems(HorizontalAlign.Start)
    }
  }

  build() {
    Column() {
      Row() {
        Text(this.failed() ? '⚠' : this.iconText())
          .fontSize(16)
          .fontColor(this.failed()
            ? $r('sys.color.ohos_id_color_alert')
            : $r('sys.color.ohos_id_color_text_secondary'))
        Text(this.labelRes())
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ left: 7 })
        if (this.contextTitleSuffix().length > 0) {
          Text(this.contextTitleSuffix())
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        if (!this.expanded && this.preview().length > 0) {
          Text(` · ${this.preview()}`)
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        } else {
          Blank()
            .layoutWeight(1)
        }
        if (this.failed()) {
          Text($r('app.string.tool_detail_failed'))
            .fontSize(11)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.ohos_id_color_alert'))
            .margin({ right: 4 })
        }
        if (this.expandable()) {
          Text(this.expanded ? '⌄' : '›')
            .fontSize(15)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
      }
      .width('100%')
      .padding({ left: 4, right: 4, top: 3, bottom: 3 })
      .borderRadius(6)
      .alignItems(VerticalAlign.Center)
      .onClick((): void => {
        if (this.expandable()) {
          this.expanded = !this.expanded;
        }
      })

      if (this.expanded) {
        this.detailBlocks()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 一条消息。
 *
 * 三个分支与源工程 `when (item.kind)` 一一对应，其中失败行**单独一支**：
 * 宁可多一个分支，也不要让这条消息落进 `else` 变成一行空的活动行。
 */
@Component
export struct ChatMessageView {
  item: ChatDisplayItem = new ChatDisplayItem('', 0, ChatItemKind.TOOL);
  images: Map<string, Uint8Array> = new Map();
  failures: Map<string, string> = new Map();
  genUiDebug: boolean = false;
  onLoadImage: (id: string) => void = (): void => {};
  onAnswer: (text: string) => void = (): void => {};

  /** 双击复制整条正文（见文件头平台差异 3：绝不能改成声明长按）。 */
  private copyBody(): void {
    writeClipboardText(this.item.body);
    this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copied') });
  }

  private copyable(): boolean {
    return this.item.body.trim().length > 0;
  }

  private failure(): ChatTurnFailure {
    return this.item.failure as ChatTurnFailure;
  }

  build() {
    Column() {
      if (this.item.kind === ChatItemKind.USER) {
        // 用户消息靠右。文字可以为空 —— 只发一张图不打字是完全正常的用法。
        Row() {
          Column() {
            if (this.item.body.trim().length > 0) {
              Text(this.item.body)
                .fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .padding({ left: 9, right: 9, top: 6, bottom: 6 })
                .borderRadius(8)
                .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
                .copyOption(CopyOptions.LocalDevice)
            }
            MessageAttachments({
              attachments: this.item.attachments,
              images: this.images,
              failures: this.failures,
              onLoadImage: this.onLoadImage,
            })
          }
          .width(USER_BUBBLE_WIDTH)
          .alignItems(HorizontalAlign.End)
        }
        .width('100%')
        .justifyContent(FlexAlign.End)
      } else if (this.item.kind === ChatItemKind.ASSISTANT) {
        AssistantBody({
          body: this.item.body,
          streaming: this.item.streaming,
          genUiDebug: this.genUiDebug,
          onAnswer: this.onAnswer,
        })
      } else if (this.item.kind === ChatItemKind.FAILURE) {
        if (this.item.failure !== null) {
          TurnFailureRow({ failure: this.failure() })
        }
      } else {
        ActivityRow({ item: this.item, onAnswer: this.onAnswer })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .gesture(GestureGroup(GestureMode.Parallel, TapGesture({ count: 2 }).onAction((): void => {
      if (this.copyable()) {
        this.copyBody();
      }
    })))
  }
}
