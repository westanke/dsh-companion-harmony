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
 */

import { inlineMarkup } from '../core/GenUiBlocks';
import { MARKDOWN_TABLE_MIN_COLUMN_VP, markdownTableColumnWidths, MdBlock, MdBlockKind, MdTable,
  markdownBlocks } from '../core/MarkdownLite';

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
