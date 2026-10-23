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
  ChatDeliverable, ChatDisplayItem, ChatItemKind, ChatTurnFailure, ToolCallDetail,
} from '../core/ChatPresentation';
import {
  GenUiDiagnosis, diagnoseGenUi, MessageSegment, MessageSegmentKind, splitMessageBody,
} from '../core/GenUiBlocks';
import { DeliverableCard, GenUiDebugLine, GenUiSegment, MessageAttachments, ToolCallDetailBlock,
  TruncatedNoticeRow, TurnFailureRow } from './MessageParts';
import { InlineText } from './InlineText';
import { MarkdownView } from './MarkdownView';
import { writeClipboardText } from '../platform/Clipboard';
import { systemLanguageTag } from '../platform/Platform';
import { chatTimeLabel } from '../core/ChatTimeLabel';
import { forkPointOf } from '../core/ChatFork';

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
  /** 点正文里的链接（会话文件名 / 网址）—— 分流规则见 `ui/ChatDetail.ets` 的 `openChatLink`。 */
  onLink: (url: string) => void = (): void => {};

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
      MarkdownView({ body: segment.text, onLink: this.onLink })
    }
  }

  /**
   * 分段渲染（正文里夹着 GenUI 卡片）时的 AI 标识兜底。
   *
   * 纯文字那支由 `MarkdownView(aiMark: true)` 贴在最后一段文字末尾；这里没有「最后一段文字」
   * 这个概念（末段可能是卡片），所以在整块内容下方补一个 —— 标识不能因为排版形态就消失。
   */
  @Builder
  aiMarkRow() {
    Row() {
      Text('AI')
        .fontSize(9)
        .fontColor($r('app.color.ai_mark'))
    }
    .width('100%')
    .padding({ top: 2 })
  }

  build() {
    Column() {
      if (this.isPlain()) {
        MarkdownView({ body: this.body, onLink: this.onLink, aiMark: true })
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
        this.aiMarkRow()
      }
      // 《人工智能生成合成内容标识办法》的标识分两层：
      // 1. **逐条**：每条助手正文末尾的浅红上标 `AI`（`MarkdownView(aiMark)` / `aiMarkRow()`），
      //    审核会逐条核「生成内容是否带标识」，所以这一层不能省；
      // 2. **会话级**：状态条常驻的「内容由 AI 生成」（`ui/ChatStatusBar.ets`，与思考条合并）。
      // 早先只有第 2 层、且每条正文下各挂一整行文字 —— 长会话里同句重复几十遍没人读，
      // 现在用「小上标 + 常驻一句」分工：好认，也不刷屏。
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
  /** 点消息里的图片 → 全屏查看（查看器与落点在 `ChatDetail`）。 */
  onOpenImage: (bytes: Uint8Array, name: string) => void = (): void => {};
  /**
   * 「重试上一轮」：由 `ChatDetail` 转给 vm 的 `retryLastUserMessage()`。
   *
   * 函数成员**不能**加 `@Prop`（见 PORT-MAP 坑 24），保持普通成员 —— 它不随状态刷新。
   */
  onRetry: () => void = (): void => {};

  /**
   * 点正文里的链接（会话文件名 / 网址）。
   *
   * 与 `onRetry` 同理，函数成员**不能**加 `@Prop`（见 PORT-MAP 坑 24）。
   * 用户气泡与助手正文都走它 —— 源工程对 USER / ASSISTANT 两类正文都做文件链接化。
   */
  onLink: (url: string) => void = (): void => {};

  /**
   * 「从这条分叉」：由 `ChatDetail` 转给 vm 的 `forkSession(sessionId, atSeq)`。
   *
   * 与 `onRetry` 同理，函数成员**不能**加 `@Prop`（见 PORT-MAP 坑 24）—— 它不随状态刷新。
   * 点击这里只上报**事件序号**；确认对话框由 `ChatDetail` 持有（同一时刻只可能有一个待确认的分叉）。
   */
  onFork: (atSeq: number) => void = (): void => {};

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

  /**
   * 这条消息的分叉点；`null` = 不给入口（判据见 `core/ChatFork.ts`：只给**用户消息**且 `seq > 0`）。
   *
   * 「只给用户消息」不是省事：真实场景几乎总是「这次提问的走向不对，从这儿重来」，
   * 每条消息都挂一个按钮会让消息流变得毛糙（源工程原话）。
   */
  private forkSeq(): number | null {
    return forkPointOf(this.item);
  }

  /**
   * 消息气泡下方的**元信息与次要动作**：时间戳，以及「从这条分叉」。
   *
   * 两条照抄源工程的判据：
   * - `time === 0`（流式项还没落盘）不显示。这是本工程用 `0` 而不是 `null` 表示「没有时间」
   *   的那条约定（见 `core/ChatPresentationTypes.ts` 里 `ChatDisplayItem.time` 的说明）。
   * - 刻意**不设** `width('100%')`：Text 默认包裹内容，行高只包住文字本身。一旦拉成全宽，
   *   这条 Text 的行高会跨出条目边界、压到下一条消息的气泡顶上 —— 源工程为此被用户连续
   *   反馈五次，见 `ui/chat/ChatMessageFooter.kt` 的文件头判据 1。
   *   同理这里的 Row 也**不设**全宽：左右对齐由父级 Column 的 `alignItems` 完成
   *   （用户 End / 助手 Start），与源工程用 `Arrangement` 得到的结果一致。
   *
   * `Date.now()` 在渲染时现取：本函数刻意不用 `Intl`（见 `core/ChatTimeLabel.ts` 取舍 1），
   * 一次 `Date` 构造加字符串拼接，开销可忽略。
   */
  @Builder
  footerRow() {
    Row() {
      if (this.item.time > 0) {
        Text(chatTimeLabel(this.item.time, Date.now(), systemLanguageTag()))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .padding({ left: 4, right: 4, top: 6, bottom: 8 })
      }
      if (this.forkSeq() !== null) {
        Row() {
          // 用 emoji 而不是 Unicode 的「⑂」：那种冷门符号在部分设备字体里没有字形，
          // 会渲染成一个方框 —— 而这一行本来就短，一个方框就很打眼。
          Text('🔀')
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          Text($r('app.string.fork_from_here'))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ left: 4 })
        }
        .padding({ left: 8, right: 8, top: 6, bottom: 8 })
        .onClick((): void => {
          const seq: number | null = this.forkSeq();
          if (seq !== null) {
            this.onFork(seq);
          }
        })
      }
    }
    .alignItems(VerticalAlign.Center)
  }

  build() {
    Column() {
      if (this.item.kind === ChatItemKind.USER) {
        // 用户消息靠右。文字可以为空 —— 只发一张图不打字是完全正常的用法。
        Row() {
          Column() {
            if (this.item.body.trim().length > 0) {
              // 底色 / 内边距 / 圆角挂在组件实例上（都是**通用属性**，落到它根的那个
              // `Text` 上）：用户气泡的宽度是「贴着文字」的，所以底色必须由文字自己背，
              // 不能挪到外层容器 —— 一挪就变成一条整宽的色带（见 `ui/InlineText.ets` 文件头）。
              InlineText({ text: this.item.body, fontSize: 14, onLink: this.onLink })
                .padding({ left: 9, right: 9, top: 6, bottom: 6 })
                .borderRadius(8)
                .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            }
            MessageAttachments({
              attachments: this.item.attachments,
              images: this.images,
              failures: this.failures,
              onLoadImage: this.onLoadImage,
              onOpenImage: this.onOpenImage,
            })
            this.footerRow()
          }
          .width(USER_BUBBLE_WIDTH)
          .alignItems(HorizontalAlign.End)
        }
        .width('100%')
        .justifyContent(FlexAlign.End)
      } else if (this.item.kind === ChatItemKind.ASSISTANT) {
        // 时间戳与正文**同一列**（见源工程 `ChatMessageFooter.kt` 的文件头判据 1）：
        // 挂在气泡外面会让这条 Text 的行高跨出 item 边界，压到下一条消息的气泡上。
        Column() {
          AssistantBody({
            body: this.item.body,
            streaming: this.item.streaming,
            genUiDebug: this.genUiDebug,
            onAnswer: this.onAnswer,
            onLink: this.onLink,
          })
          this.footerRow()
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      } else if (this.item.kind === ChatItemKind.FAILURE) {
        if (this.item.failure !== null) {
          TurnFailureRow({
            failure: this.failure(),
            onRetry: this.onRetry,
          })
        }
      } else if (this.item.kind === ChatItemKind.TRUNCATED) {
        // 黄色警示，不是失败行：已有输出是有效内容，不需要「重试上一轮」。
        TruncatedNoticeRow()
      } else if (this.item.kind === ChatItemKind.DELIVERABLE) {
        // agent 用 present 工具显式交付的文件 —— DeliverableCard 走 onLink(path) →
        // openSessionFileFromLink，与正文里的文件链接同一条通道。
        DeliverableCard({ deliverable: this.item.deliverable as ChatDeliverable, onLink: this.onLink })
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
