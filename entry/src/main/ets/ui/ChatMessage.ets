/**
 * 聊天消息的**组装层** —— 移植自原工程 `ui/ChatScreen.kt` 里从 `ChatItem` 到 `ToolTextBlock`
 * 那一整段（约 2430–3050 行）。
 *
 * ## 拆分说明（本文件现在只剩"骨架"）
 *
 * 拆分前这是 1 099 行的一个大文件，按领域分成了三份：
 *
 * | 文件 | 装什么 |
 * |---|---|
 * | `ui/MarkdownView.ets` | 极简 Markdown 渲染器（消息正文与文件页预览共用） |
 * | `ui/MessageParts.ets` | 消息里的各个零件：dsh-ui 片段、附件图、失败行、工具详情块…… |
 * | `ui/ChatMessage.ets`（本文件） | 一条消息的骨架（`ChatMessageView`）＋助手正文（`AssistantBody`）＋活动行（`ActivityRow`） |
 *
 * **对外接口不变**：`ChatMessageView`、`MarkdownView`、`GenUiDebugLine` 仍然从本文件导出
 * （后两者在本文件末尾按"转发导出"再导出一次）。拆分是机械的挪动，没有任何行为变化。
 *
 * ## 与源工程的对应关系
 *
 * | 源工程 | 本工程 |
 * |---|---|
 * | `ChatItem` | `ChatMessageView`（本文件） |
 * | `AssistantBody` | `AssistantBody`（本文件） |
 * | `Markdown` | `MarkdownView`（`ui/MarkdownView.ets`） |
 * | `ActivityRow` | `ActivityRow`（本文件） |
 * | 其余零件 | `ui/MessageParts.ets` |
 *
 * ## 两处必须说明的平台差异
 *
 * 1. **复制手势用双击**，与源工程一字不差。源工程的注释里记了一次翻车：早期给整条消息
 *    挂 `onLongClick`，长按被外层吃掉，`SelectionContainer` 的选择手柄永远弹不出来。
 *    ArkUI 这边同理 —— 文本选择靠 `copyOption(CopyOptions.LocalDevice)`（长按触发），
 *    所以外层**只能**声明双击手势，绝不能声明长按。
 * 2. **判断「一条消息是否为空」时，用户消息的文字可以为空**（只发图不打字是正常用法），
 *    所以判空只挡文字气泡、不挡附件渲染。
 *
 * ## 一处照抄源工程、不许简化的判据
 *
 * `ActivityRow` 的展开判据：有逐条明细（`tools` 非空）**一定**可展开 —— 这就是
 * 「工具调用详情」的入口；工具行合并成一组后也要能展开；单次调用那一行没什么可展的。
 */

import {
  ChatDisplayItem, ChatItemKind, ChatTurnFailure, ToolCallDetail,
} from '../core/ChatPresentation';
import {
  GenUiDiagnosis, diagnoseGenUi, MessageSegment, MessageSegmentKind, splitMessageBody,
} from '../core/GenUiBlocks';
import { GenUiDebugLine, GenUiSegment, MessageAttachments, ToolCallDetailBlock,
  TurnFailureRow } from './MessageParts';
import { MarkdownView } from './MarkdownView';
import { writeClipboardText } from '../platform/Clipboard';

/** 助手正文的最大宽度（vp）：对位源工程的 `widthIn(max = 720.dp)`。 */
const ASSISTANT_MAX_WIDTH_VP: number = 720;

/** 用户气泡占屏宽的比例：对位 `fillMaxWidth(0.78f)`。 */
const USER_BUBBLE_WIDTH: string = '78%';

/**
 * 转发导出：这两个组件已挪到别的文件，但**引入方一个字都不用改** ——
 * `ui/FilesScreen.ets` 与 `ui/SessionFilesSheet.ets` 仍然 `import { MarkdownView } from './ChatMessage'`。
 */
export { MarkdownView } from './MarkdownView';
export { GenUiDebugLine } from './MessageParts';

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
      // 《人工智能生成合成内容标识办法》要求在生成内容上做**显式标识**：
      // 助手正文一律带一行可见提示，供用户与审核一眼辨认（AGC 2026-10-16 驳回项「未提交
      // 人工智能生成合成内容标识相关材料」的代码侧整改）。
      Text($r('app.string.ai_generated_notice'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 6 })
    }
    .width('100%')
    .constraintSize({ maxWidth: ASSISTANT_MAX_WIDTH_VP })
    .padding({ left: 2, right: 2, top: 2, bottom: 2 })
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
