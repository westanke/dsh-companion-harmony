/**
 * 工具调用专用块的表现层 —— Read / Terminal / Diff 三种长相（对标官方 Web）。
 *
 * 对应源工程 `ui/chat/ChatToolBlocks.kt`。**形态怎么算**在 `core/ToolBlocks.ts`（那份能离线单测），
 * 本文件只管怎么画。
 *
 * ## 为什么是独立组件，而不是父组件里的几个 `@Builder`
 *
 * ArkUI 的 `build()` 与 `@Builder` 方法体**只允许 UI 描述、不允许声明局部变量** ——
 * 实测在 `build()` 里写 `const view = toolBlockView(tool)` 会直接
 * `CompileArkTS` 失败（`In an '@Entry' decorated component, the 'build' method can have only
 * one root node`）。于是「投影一次、多处复用」只能靠**组件 + `@Prop`** 达成：
 * 父组件在构造参数里投影一次，本组件成员里就有一份现成的 `view`，各处直接读 `this.view.xxx`，
 * 不必反复解析 arguments，也就不会出现「同一行里调三遍」的啰嗦写法。
 *
 * `@Prop`（而不是普通成员）是必须的：专用块内容随流式更新变化，
 * 普通成员只在构造时赋一次值、父组件重绘不会回写（见 PORT-MAP 坑 40）。
 *
 * ## 与 Generic 的分工 —— 兜底不在本文件
 *
 * 本组件只负责三种专用形态，**回落与错误回显都在父组件**（`ToolCallDetailBlock.build()`）：
 * - `Generic`（未知工具、arguments 坏 JSON）仍由父组件平铺参数 + 结果；
 * - `read` **失败**时也不进本组件 —— 失败时 result 是错误原文、不含 `<content>`，
 *   当成「文件正文」显示会让人以为文件里就写着那句报错；
 * - `diff` 失败时父组件在本组件之后再补一个结果块（错误原文红底）。
 */
import { ToolBlockKind, ToolBlockView } from '../core/ToolBlocks';
import { ToolTextBlock } from './MessageParts';

@Component
export struct ToolBlockBody {
  /** 由父组件投影好的形态（`core/ToolBlocks.toolBlockView` 的产物）。 */
  @Prop view: ToolBlockView = new ToolBlockView();
  /** 工具是否失败 —— 终端块要用它决定输出底色（失败的输出是红色错误原文）。 */
  @Prop failed: boolean = false;

  /** 每行加前缀 —— diff 按惯例逐行标记，整段拼一个块（复制一次拿到完整改动）。 */
  private prefixedLines(text: string, mark: string): string {
    const lines: string[] = text.split('\n');
    const out: string[] = [];
    for (let i: number = 0; i < lines.length; i++) {
      out.push(`${mark} ${lines[i]}`);
    }
    return out.join('\n');
  }

  /** `edit`/`write` 的改动文本：旧文逐行 `- `、新文逐行 `+ `；`write` 无旧文（新建文件）。 */
  private diffText(): string {
    const removed: string = this.view.oldText === null ? '' : this.prefixedLines(this.view.oldText, '-');
    const added: string = this.view.newText.length === 0 ? '' : this.prefixedLines(this.view.newText, '+');
    if (removed.length === 0) {
      return added;
    }
    if (added.length === 0) {
      return removed;
    }
    return `${removed}\n${added}`;
  }

  /**
   * `read` / `read_image`：路径 + 正文（正文自带行号就不再补，判据在 `ToolBlocks.extractReadBody`）。
   * 路径用等宽单行省略 —— 长路径不该把详情块撑宽。
   */
  @Builder
  readBlock() {
    if (this.view.path.length > 0) {
      Text(this.view.path)
        .fontSize(11)
        .fontFamily('monospace')
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
    }
    if (this.view.body.length > 0) {
      ToolTextBlock({
        label: $r('app.string.tool_block_file'),
        text: this.view.body,
        isError: false,
        maxHeightVp: 260,
      })
    } else {
      Text($r('app.string.tool_detail_empty_result'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    }
  }

  /**
   * `bash`：终端提示符 + 命令 + 输出（输出已剥 ANSI）。
   *
   * 「运行中」与「跑完没输出」**分开**显示（`running` 来自 `result === null`）——
   * 把两者混成一个「无输出」会让人以为命令已经跑完了。
   */
  @Builder
  terminalBlock() {
    Text(`$ ${this.view.command}`)
      .fontSize(12)
      .fontFamily('monospace')
      .width('100%')
    if (this.view.description.length > 0) {
      Text(this.view.description)
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 2 })
    }
    if (this.view.running) {
      Text($r('app.string.tool_detail_pending'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 4 })
    } else if (this.view.output.length === 0) {
      Text($r('app.string.tool_detail_empty_result'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 4 })
    } else {
      ToolTextBlock({
        label: $r('app.string.tool_detail_output'),
        text: this.view.output,
        isError: this.failed,
        maxHeightVp: 260,
      })
    }
  }

  @Builder
  diffBlock() {
    if (this.view.path.length > 0) {
      Text(this.view.path)
        .fontSize(11)
        .fontFamily('monospace')
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
    }
    ToolTextBlock({
      label: $r('app.string.tool_block_diff'),
      text: this.diffText(),
      isError: false,
      maxHeightVp: 260,
    })
  }

  build() {
    Column() {
      if (this.view.kind === ToolBlockKind.Read) {
        this.readBlock()
      } else if (this.view.kind === ToolBlockKind.Terminal) {
        this.terminalBlock()
      } else {
        this.diffBlock()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
