/**
 * 极简 Markdown 渲染（块级）—— 从 `ui/ChatMessage.ets` 拆出（见该文件头的「拆分说明」）。
 *
 * ## 为什么单独成文件
 *
 * 这个渲染器有**三个消费者**、两套字号口径：聊天正文（`AssistantBody` / `ActivityRow` 的
 * 思考行）用它、文件页的预览用它。它自己又不依赖消息域的任何类型，只吃一个字符串，
 * 所以放在消息文件里既撑大了行数，也让「改渲染」与「改消息布局」两类改动互相踩脚。
 *
 * ## 平台差异（照抄源工程的第 1、4 条，详见 `ui/ChatMessage.ets` 文件头）
 *
 * 1. **渲染器是自备的**（`core/MarkdownLite.ts`）。源工程用 `com.mikepenz.markdown.m3`，
 *    那是 Android 专有库；ArkUI 没有等价物。这里只做块级排版（标题 / 列表 / 引用 / 代码 /
 *    **表格** / 分隔线 / 段落），行内标记统一由 `inlineMarkup` 剥掉。
 * 2. **表格要横向滚、列宽要自己定**：ArkUI 的 `Scroll` 只支持单方向，所以横向滚动**只加在
 *    最外层** —— 套在表格外面，列宽才不会被无界宽度约束带偏（`GenUiCard` 踩过同一个坑）。
 *    列宽由 `markdownTableColumnWidths` 按内容估，估出来的宽度被 `width()` 定死。
 *
 * ## 表格的「像一张表」（真机反馈四修，2026-10-17）
 *
 * 前三版表格被连反馈三次「**表格不像表**」：截图里那些「证据 / 结果」行看起来就是普通文字
 * 行。根因是**只有单元格文字、没有表的结构**。第四版补上四件东西，缺一件都还是「一段文字」：
 * 外框一道边（+ 圆角）、表头行（深底，与数据行分明）、行与行之间的分隔线、
 * 列与列之间的竖线。折行与表格感**两个都要**，不是二选一 —— 这是前三版反复的教训。
 *
 * 列宽仍然按内容估（本工程的做法，比源工程的「第一列固定上限」更能容纳多列表格）；
 * 总宽超出屏幕时横向滚。估出的单列上限是 `MARKDOWN_TABLE_MAX_COLUMN_VP`，所以长句会在
 * 列内折行，而不是把表撑成无限宽。
 *
 * ## 代码块高亮（真机反馈三修，2026-10-17）
 *
 * 代码块走 `core/CodeHighlight.ts`：`highlightCode` 算出区间、`codeSegments` 摊成
 * 「一段文字 + 一个类别」，这里再把每段包成一个 `Span`。
 *
 * **拼起来必须逐字符等于原文**（高亮只加样式，不改字符）—— 界面按原文排版与复制，
 * 少一个字符，行号与剪贴板内容就全歪了。所以这里不 trim、不补换行。
 *
 * 源工程用 `remember(code, language)` 缓存高亮结果（文本没变的重组直接复用）。
 * ArkUI 的 `@Builder` 里没有等价的「按 key 记忆」，所以本组件自己留一份有界缓存
 * （见 `codeSegmentsOf`）—— 语义与源工程一致：**只省「文本没变」的那次重算**。
 */

import { inlineMarkup } from '../core/GenUiBlocks';
import { MARKDOWN_TABLE_MIN_COLUMN_VP, markdownTableColumnWidths, MdBlock, MdBlockKind, MdTable,
  markdownBlocks } from '../core/MarkdownLite';
import { CodeSegment, CodeTokenKind, codeSegments, highlightCode } from '../core/CodeHighlight';
import { writeClipboardText } from '../platform/Clipboard';
import { InlineText } from './InlineText';

/**
 * 高亮缓存的容量上限（条数）。
 *
 * 会话页里同时存在的代码块数量有限，8 条足够覆盖「一屏里的几个代码块」（工具详情另走
 * `MessageParts.ToolTextBlock`，不经过这里）；满了整体清空，而不是按访问时间淘汰 ——
 * 前者实现只有一行，后者要维护一个访问队列，而后者省下的那点重算不值得。
 */
const CODE_CACHE_LIMIT: number = 8;

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
  /**
   * 点链接（标题 / 列表 / 引用 / 正文段落里的 `[文字](目标)`）。
   *
   * 资源在「文件」页预览里不会出现，那里可以不传（默认为空实现，点了没反应但不报错）。
   * 表格单元格不经过这里 —— 理由见 `ui/InlineText.ets` 文件头。
   */
  onLink: (url: string) => void = (): void => {};
  /**
   * 是否在**最后一段文字**末尾追加浅红上标 `AI`（助手消息的显式标识，见 `InlineText.aiMark`）。
   *
   * 最后一块是代码 / 表格 / 分隔线时没有「文字段」可贴，界面改为在内容下方补一个小标识
   * （`markRow`）—— 标识**不能因为排版形态不同就消失**，那是审核会逐条比对的东西。
   */
  aiMark: boolean = false;

  private blocks(): MdBlock[] {
    return markdownBlocks(this.body);
  }

  /** 最后一块是不是可承载行内上标的文字块（段落 / 标题 / 列表 / 引用）。 */
  private lastIsText(): boolean {
    const list: MdBlock[] = this.blocks();
    if (list.length === 0) {
      return false;
    }
    const kind: MdBlockKind = list[list.length - 1].kind;
    return kind === MdBlockKind.HEADING || kind === MdBlockKind.BULLET || kind === MdBlockKind.ORDERED ||
      kind === MdBlockKind.QUOTE || kind === MdBlockKind.PARAGRAPH;
  }

  /** 末块不是文字时的兜底标识（理由见 `aiMark`）。 */
  @Builder
  markRow() {
    Row() {
      Text('AI')
        .fontSize(9)
        .fontColor($r('app.color.ai_mark'))
    }
    .width('100%')
    .justifyContent(FlexAlign.End)
    .padding({ top: 2 })
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

  /** 高亮缓存：`语言 + 原文` → 分段（见文件头「代码块高亮」与 `CODE_CACHE_LIMIT`）。 */
  private codeCache: Map<string, CodeSegment[]> = new Map();

  private codeSegmentsOf(text: string, lang: string): CodeSegment[] {
    const key: string = `${lang}\u0000${text}`;
    const cached: CodeSegment[] | undefined = this.codeCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const segments: CodeSegment[] = codeSegments(text, highlightCode(text, lang));
    if (this.codeCache.size >= CODE_CACHE_LIMIT) {
      this.codeCache.clear();
    }
    this.codeCache.set(key, segments);
    return segments;
  }

  /**
   * 高亮类别的配色。
   *
   * 全部走**系统色**（`sys.color.*`）而不是写死的十六进制：应用支持浅色 / 深色 / 跟随系统
   * 三档主题，系统色会跟着主题自动换；写死一套色板，深色模式下必然有一头读不清。
   *
   * 五类归到三种颜色：关键字 / 键 / 字面量同色（它们在阅读上是同一类「语法骨架」），
   * 字符串与数字同色，注释压到第三级灰 —— 注释本来就该退到背景里去。
   */
  private tokenColor(kind: CodeTokenKind): Resource {
    if (kind === CodeTokenKind.COMMENT) {
      return $r('sys.color.ohos_id_color_text_tertiary');
    }
    if (kind === CodeTokenKind.STRING || kind === CodeTokenKind.NUMBER) {
      return $r('sys.color.ohos_id_color_warning');
    }
    if (kind === CodeTokenKind.PLAIN) {
      return $r('sys.color.ohos_id_color_text_primary');
    }
    return $r('sys.color.ohos_id_color_emphasize');
  }

  /**
   * 列与列之间的竖线。
   *
   * 用「1vp 宽的色块 + `alignSelf(Stretch)`」而不是 `Divider().vertical(true)`：
   * Divider 竖直时要显式给高，而这里每行的高度由文字折行决定、算不出来；
   * `Stretch` 让这根线自动长到行高 —— 与引用块那条左边线是同一套做法（见 QUOTE 分支）。
   *
   * `alignSelf` 会**覆盖**行容器的 `alignItems`，所以文字那一侧仍然是顶对齐。
   */
  @Builder
  cellSeparator() {
    Column()
      .width(1)
      .alignSelf(ItemAlign.Stretch)
      .backgroundColor($r('sys.color.ohos_id_color_list_separator'))
  }

  @Builder
  tableView(table: MdTable) {
    // 横向滚动只加在最外层（见文件头平台差异 2）。
    Scroll() {
      Column() {
        // ── 表头行：深底 + 加粗，一眼看出「这是列名」而不是数据 ──
        Row() {
          ForEach(table.header, (cell: string, columnIndex: number) => {
            if (columnIndex > 0) {
              this.cellSeparator()
            }
            Text(inlineMarkup(cell))
              .fontSize(this.headerCellSize())
              .fontWeight(FontWeight.Medium)
              .width(this.columnWidthAt(table, columnIndex))
              .padding(8)
          }, (cell: string, columnIndex: number) => `th-${columnIndex}-${cell}`)
        }
        .width(this.tableWidthOf(table))
        .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
        .alignItems(VerticalAlign.Top)

        // 表头下那条线用**更重**的一笔：它是「列名 / 数据」的分界，与行间线同粗会看不出来。
        // 宽度必须显式给：横向滚动的子级拿到的是**无界**宽度约束，
        // Divider 默认铺满 —— 无界下会塌成 0 宽，这条线整个不见。
        Divider()
          .strokeWidth(2)
          .width(this.tableWidthOf(table))
          .color($r('sys.color.ohos_id_color_list_separator'))

        ForEach(table.rows, (cells: string[], rowIndex: number) => {
          if (rowIndex > 0) {
            Divider()
              .strokeWidth(1)
              .width(this.tableWidthOf(table))
              .color($r('sys.color.ohos_id_color_list_separator'))
          }
          Row() {
            ForEach(table.header, (column: string, columnIndex: number) => {
              if (columnIndex > 0) {
                this.cellSeparator()
              }
              Text(columnIndex < cells.length ? inlineMarkup(cells[columnIndex]) : '')
                .fontSize(this.cellSize())
                .width(this.columnWidthAt(table, columnIndex))
                .padding(8)
            }, (column: string, columnIndex: number) => `td-${rowIndex}-${columnIndex}`)
          }
          .width(this.tableWidthOf(table))
          .alignItems(VerticalAlign.Top)
        }, (cells: string[], rowIndex: number) => `tr-${rowIndex}-${cells.length}`)
      }
      .width(this.tableWidthOf(table))
      // 外框一道边 + 圆角：没有这道边，内部再多分隔线也还是一段文字。
      // 同时设了 `.clip(true)`：表头那块底色会被裁进圆角里，否则四个直角会戳出边框。
      .clip(true)
      .border({
        width: 1,
        color: $r('sys.color.ohos_id_color_list_separator'),
        radius: 6,
      })
      .alignItems(HorizontalAlign.Start)
    }
    .scrollable(ScrollDirection.Horizontal)
    .width('100%')
    .align(Alignment.TopStart)
    .margin({ top: 4, bottom: 6 })
  }

  /** 复制**原始代码原文**（不是屏幕上带标签的整块）：多一行 ```kotlin 粘进编辑器就是语法错。 */
  private copyCode(code: string): void {
    writeClipboardText(code);
    this.getUIContext().getPromptAction().showToast({ message: $r('app.string.copied') });
  }

  @Builder
  codeView(block: MdBlock) {
    Column() {
      // ── 顶栏：语言标签在左、复制键在右 ──
      //
      // 语言为空时**照样保留整条顶栏**（只空着标签）：顶栏高度若随语言有无上下跳，
      // 复制键就会在消息之间错位，用户按肌肉记忆点下去会点到隔壁去（源工程原话）。
      Row() {
        Text(block.lang)
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .layoutWeight(1)
        Text($r('app.string.tool_detail_copy'))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .onClick((): void => {
            this.copyCode(block.text);
          })
      }
      .width('100%')
      .padding({ left: 10, right: 4, top: 4 })
      .alignItems(VerticalAlign.Center)

      // 横向 Scroll 包一层：终端输出与 diff 经常是「很宽的一行 + 很多行」，
      // 硬折行会把缩进层次全打乱（源工程 `softWrap = false` 的同一件事）。
      Scroll() {
        Text() {
          ForEach(this.codeSegmentsOf(block.text, block.lang), (segment: CodeSegment, segmentIndex: number) => {
            Span(segment.text)
              .fontColor(this.tokenColor(segment.kind))
          }, (segment: CodeSegment, segmentIndex: number) => `${segmentIndex}:${segment.kind}:${segment.text.length}`)
        }
        .fontSize(this.scaled(12))
        .fontFamily('monospace')
        // 兜底色：`Span` 只覆盖被认出来的区间，未着色的部分靠这一行定色。
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .padding({ left: 10, right: 10, top: 2, bottom: 10 })
        .copyOption(CopyOptions.LocalDevice)
      }
      .scrollable(ScrollDirection.Horizontal)
      .width('100%')
      .align(Alignment.TopStart)
    }
    .width('100%')
    .borderRadius(6)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  blockView(block: MdBlock, index: number, mark: boolean) {
    if (block.kind === MdBlockKind.HEADING) {
      InlineText({
        text: block.text,
        fontSize: this.headingSize(block.level),
        fontWeight: block.level <= 3 ? FontWeight.Bold : FontWeight.Medium,
        onLink: this.onLink,
        aiMark: mark,
      })
        .width('100%')
        .margin({ top: 8, bottom: 2 })
    } else if (block.kind === MdBlockKind.BULLET) {
      Row() {
        Text('•')
          .fontSize(this.scaled(14))
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        // `layoutWeight` 挂在标准容器（Column）上而不是自定义组件实例上：
        // 自定义组件实例只保证收通用属性，`layoutWeight` 这类影响父级测量的属性
        // 在实例上是否生效没有明确保障 —— 多套一层零风险。
        Column() {
          InlineText({
            text: block.text,
            fontSize: this.scaled(14),
            onLink: this.onLink,
            aiMark: mark,
          })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 6 })
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
        Column() {
          InlineText({
            text: block.text,
            fontSize: this.scaled(14),
            onLink: this.onLink,
            aiMark: mark,
          })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
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
        Column() {
          InlineText({
            text: block.text,
            fontSize: this.scaled(14),
            secondary: true,
            onLink: this.onLink,
            aiMark: mark,
          })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 8 })
      }
      .width('100%')
      .padding({ top: 2, bottom: 2 })
    } else if (block.kind === MdBlockKind.CODE) {
      this.codeView(block)
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
      InlineText({
        text: block.text,
        fontSize: this.scaled(14),
        lineHeight: this.scaled(21),
        onLink: this.onLink,
        aiMark: mark,
      })
        .width('100%')
    }
  }

  build() {
    Column() {
      ForEach(this.blocks(), (block: MdBlock, index: number) => {
        this.blockView(block, index, this.aiMark && index === this.blocks().length - 1)
      }, (block: MdBlock, index: number) => this.keyOf(block, index))
      // 末块是代码 / 表格 / 分隔线时贴不出行内上标，改为在下方补一个（理由见 `aiMark`）。
      if (this.aiMark && this.blocks().length > 0 && !this.lastIsText()) {
        this.markRow()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
