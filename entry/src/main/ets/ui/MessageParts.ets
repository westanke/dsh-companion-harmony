/**
 * 消息气泡的各个「零件」—— 从 `ui/ChatMessage.ets` 拆出（见该文件头的「拆分说明」）。
 *
 * 装的是**被 `ChatMessageView` 组装起来的小组件**，彼此之间只有"嵌套"一种关系：
 *
 * | 组件 | 管什么 | 对应源工程 |
 * |---|---|---|
 * | `GenUiSegment` | 一个 dsh-ui 片段的解析与渲染 | `GenUiSegment` |
 * | `GenUiDebugLine` | dsh-ui 诊断行（设置里开开关才出现） | `GenUiDebugLine` |
 * | `AttachmentImage` | 单张附件图（先解码再画） | `AttachmentNotice` 的图片支 |
 * | `MessageAttachments` | 一条消息的图片列表 | `MessageAttachments` |
 * | `TurnFailureRow` | 一轮运行的终局失败行 | `TurnFailureRow` |
 * | `TruncatedNoticeRow` | 「回答被截断」提示行（黄色警示，不是失败） | `TruncatedNoticeRow` |
 * | `ToolTextBlock` | 可滚动可复制的等宽文本（工具输入/输出） | `ToolTextBlock` |
 * | `ToolCallDetailBlock` | 一条工具调用的详情块 | `ToolCallDetailBlock` |
 *
 * 三条照抄源工程、不许简化的判据（原在 `ChatMessage.ets` 文件头，随代码挪来）：
 *
 * 1. **图片要先解码**（`platform/ImageCodec.ets`）。ArkUI 的 `Image()` 不接受原始字节，
 *    只认 `PixelMap`；解码放在 `AttachmentImage.aboutToAppear`，解不出来就显示
 *    「这张图片无法显示」（对应源工程 `BitmapFactory` 返回 null 的那一支）。
 * 2. **工具行的「把失败显示在折叠态」**：用户点开详情最主要的理由就是「刚才那条命令
 *    报了什么错」，所以 `failed` 时折叠态也要有红色「失败」两字与感叹号图标。
 * 3. **`tool.result == null` 与 `tool.result == ""` 是两种状态**（还没有结果 / 结果为空），
 *    文案不同，不能合并成一个分支。
 *
 * 这些组件原先不带 `export`（只给同文件的 `ChatMessageView` 用），拆开后都改成
 * `export struct` —— 跨文件的引用必须显式导出，这是拆分的机械代价，不是语义变化。
 */

import {
  ChatAttachment, ChatDeliverable, ChatDisplayItem, ChatTurnFailure, formatToolDuration, prettyToolArguments,
  ToolCallDetail,
} from '../core/ChatPresentation';
import { GenUiDiagnosis, diagnoseGenUi, GenUiSpec, parseGenUi } from '../core/GenUiBlocks';
import { ToolBlockKind, toolBlockView } from '../core/ToolBlocks';
import { ToolBlockBody } from './ToolBlockBody';
import { localizedErrorText } from '../core/ErrorMessages';
import { GenUiCard } from './GenUiCard';
import { MarkdownView } from './MarkdownView';
import { writeClipboardText } from '../platform/Clipboard';
import { decodeImageSync } from '../platform/ImageCodec';
import { systemLanguageTag } from '../platform/Platform';

/**
 * 一个 dsh-ui 片段。
 *
 * 单独成一个组件而不是内联在 `AssistantBody` 里，是为了让「解析一次」这件事落在
 * `aboutToAppear` 上：`@Builder` 里不能声明局部变量，写在表达式里就得解析两遍
 * （一次判空、一次传参）。
 */
@Component
export struct GenUiSegment {
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
export struct AttachmentImage {
  attachmentId: string = '';
  bytes: Uint8Array | null = null;
  mediaType: string = '';
  /** 附件原名（服务端给的）；保存到本地时用它当默认文件名。 */
  name: string = '';
  failure: string | null = null;
  onLoad: (id: string) => void = (): void => {};
  /**
   * 点缩略图 → 打开全屏查看（对位源工程 `ChatImageViewer.kt` 的缩略图那半边）。
   *
   * **只有解码成功（有 `pixelMap`）才会调**：把字节交给一个连本组件都画不出来的查看器，
   * 用户只会看到一整屏黑，比「点不动」更迷糊。
   */
  onOpen: (bytes: Uint8Array, name: string) => void = (): void => {};

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
          .onClick((): void => {
            const raw: Uint8Array | null = this.bytes;
            if (raw !== null) {
              this.onOpen(raw, this.name);
            }
          })
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
export struct MessageAttachments {
  attachments: ChatAttachment[] = [];
  /** 已取到的字节，按 attachmentId 索引。 */
  images: Map<string, Uint8Array> = new Map();
  /** 取图失败的原因（已本地化），按 attachmentId 索引。 */
  failures: Map<string, string> = new Map();
  onLoadImage: (id: string) => void = (): void => {};
  /** 点开一张图 → 全屏查看（字节直接带上，避免查看器再走一次 vm 取图）。 */
  onOpenImage: (bytes: Uint8Array, name: string) => void = (): void => {};

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
            // `name` 为 null 时给空串：`galleryFileName` 会把空串回落成 `image`，
            // 这里不必提前替它决定名字。
            name: attachment.name === null ? '' : attachment.name,
            failure: this.failureOf(attachment.attachmentId),
            onLoad: this.onLoadImage,
            onOpen: this.onOpenImage,
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
 *
 * 「重试上一轮」只给**模型故障**那一支（`stopped == false`）：登出/主动停止是用户自己的
 * 动作，重试必然再失败一次 —— 一个点了只会再错一遍的按钮比没有按钮更糟。
 * 这条判据在界面上而不在 vm 里：vm 的 `retryLastUserMessage()` 只管「重试」这个动作本身。
 */
@Component
export struct TurnFailureRow {
  failure: ChatTurnFailure = new ChatTurnFailure();

  /**
   * 点「重试上一轮」时做什么（由 `ChatMessageView` 转给 vm 的 `retryLastUserMessage()`）。
   *
   * 函数成员**不能**加 `@Prop`（会连闭包一起深拷贝坏掉，见 PORT-MAP 坑 24），
   * 保持普通成员 —— 它本身也不需要随状态刷新。
   */
  onRetry: () => void = (): void => {};

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

      if (!this.failure.stopped) {
        Text($r('app.string.retry'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .padding({ left: 10, right: 10, top: 5, bottom: 5 })
          .margin({ top: 4 })
          .borderRadius(6)
          .border({ width: 1, color: $r('sys.color.ohos_id_color_button_normal') })
          .onClick((): void => {
            this.onRetry();
          })
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
 * 「回答被截断」提示行（源工程 `TruncatedNoticeRow`）。
 *
 * 为什么**不复用** `TurnFailureRow`：截断不是失败 —— 已有的输出是有效内容，
 * 红框 + 重试按钮会让用户以为整轮白跑。安卓用的是 Material3 的
 * `tertiaryContainer`（黄）而不是 `errorContainer`（红），这里对齐成
 * 淡黄底 + 琥珀色文字，深浅主题各一份颜色（`resources/{base,dark}/element/color.json`）。
 *
 * 两行文案都在资源里：标题说「为什么停下」，副文案告诉用户「发"继续"就行」——
 * 缺了后者，用户只会以为模型坏了。
 */
@Component
export struct TruncatedNoticeRow {
  build() {
    Row() {
      // U+FE0E 是「文本呈现」选择符：不加它这个字符可能被渲染成彩色 emoji，
      // fontColor 会被无视，与琥珀色主题不搭。
      Text('⚠\uFE0E')
        .fontSize(14)
        .fontColor($r('app.color.turn_truncated_text'))
      Column() {
        Text($r('app.string.turn_max_tokens_title'))
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.turn_truncated_text'))
          .width('100%')
        Text($r('app.string.turn_max_tokens_hint'))
          .fontSize(12)
          .fontColor($r('app.color.turn_truncated_text'))
          .width('100%')
          .margin({ top: 2 })
          .copyOption(CopyOptions.LocalDevice)
      }
      .layoutWeight(1)
      .margin({ left: 7 })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 7, bottom: 7 })
    .backgroundColor($r('app.color.turn_truncated_bg'))
    .borderRadius(8)
    .border({ width: 1, color: $r('app.color.turn_truncated_border') })
    .alignItems(VerticalAlign.Top)
  }
}
/**
 * 一段可滚动、可复制、等宽显示的工具文本（输入或输出）。
 *
 * 两个轴都要能滚：终端输出经常是「很宽的一行 + 很多行」，只给纵向滚动的话宽行会被
 * 硬折行，缩进层次就全乱了。ArkUI 的一个 `Scroll` 只支持单方向，所以纵向套横向。
 */
@Component
export struct ToolTextBlock {
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
export struct ToolCallDetailBlock {
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

  /** 形态判别（每次现算 —— ArkUI 的 build/@Builder 里不允许声明局部变量）。 */
  private viewKind(): ToolBlockKind {
    return toolBlockView(this.tool).kind;
  }

  /** 原有长相：格式化后的输入 + 结果。Generic 与「read 失败」两种情况共用。 */
  @Builder
  genericBody() {
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

      if (this.viewKind() === ToolBlockKind.Generic
        || (this.viewKind() === ToolBlockKind.Read && this.tool.failed)) {
        this.genericBody()
      } else {
        // 投影一次、按值传给子组件（子组件用 @Prop 接，见 ToolBlockBody）。
        ToolBlockBody({ view: toolBlockView(this.tool), failed: this.tool.failed })
        // Terminal 自己已经把输出显示出来了（失败时红底）；Read/Diff 只显示正文/改动，
        // 工具失败时的**错误原文**必须补出来，不能只剩一个「改动」块。
        if (this.viewKind() === ToolBlockKind.Diff && this.tool.failed) {
          this.resultBlock()
        }
      }
    }
    .width('100%')
    .margin({ top: 6 })
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 显式交付物卡片（agent 用 `present` 工具交付的文件）。
 *
 * 对齐桌面端：文件图标 + 文件名（取路径最后一段） + agent 写的说明（如果有），
 * 整卡可点击 → 走 `onLink(path)` → 服务端绝对路径 → `openSessionFileFromLink` →
 * 打开「本会话的文件」面板（与正文里的文件链接完全同一条通道）。
 *
 * 数据来源：`ChatItemBuilders.oneEntryItems` 把 `deliverables/presented` 事件转成
 * `ChatDisplayItem(kind=DELIVERABLE, deliverable=...)`，这里消费它。
 *
 * 样式：半透明边框 + 左边竖线（颜色与活动行区分，但不抢正文风头）。
 */
@Component
export struct DeliverableCard {
  deliverable: ChatDeliverable = new ChatDeliverable('');
  onLink: (url: string) => void = (): void => {};

  /** 取路径最后一段作为文件名 —— 完整绝对路径太冗长。 */
  private fileName(): string {
    const p: string = this.deliverable.path;
    const idx: number = p.lastIndexOf('/');
    return idx >= 0 ? p.substring(idx + 1) : p;
  }

  build() {
    Row() {
      // 左边竖线 —— 让卡片在消息流里能一眼辨认，又不像用户气泡/助手正文那么重。
      // **禁止 height('100%')**：父 Row 是 wrap-content 高度，百分比高度会按可用约束
      // （列表视口）解析，把整张卡撑满一屏（真机实测踩过）。竖条高度用
      // `alignSelf(ItemAlign.Stretch)` 拉伸到 Row 的实际内容高度（ArkUI 的
      // VerticalAlign 没有 Stretch，只有子项自对齐有）。
      Column()
        .width(3)
        .alignSelf(ItemAlign.Stretch)
        .backgroundColor($r('sys.color.ohos_id_color_text_secondary'))
        .opacity(0.4)
        .margin({ right: 10 })

      Column() {
        // 文件图标 emoji + 文件名（加粗，一眼可辨）。
        Row() {
          Text('📎')
            .fontSize(14)
          Text(this.fileName())
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        // agent 写的说明（如果有）。
        if (this.deliverable.description !== null && this.deliverable.description!.trim().length > 0) {
          Text(this.deliverable.description!.trim())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 3 })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
    .borderRadius(8)
    .border({ width: 0.5, color: $r('sys.color.ohos_id_color_text_secondary') })
    .opacity(0.9)
    .margin({ top: 6 })
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      // 直接把绝对路径当 URL 传给 onLink ——
      // ChatLinkTarget.classify 会认出来是 SERVER_PATH → openSessionFileFromLink。
      this.onLink(this.deliverable.path);
    })
  }
}
