/**
 * 会话文件面板 —— 移植自原工程 `ui/ChatScreen.kt` 的
 * `SessionFilesSheet` / `SessionFileList` / `SessionFileRow` / `SessionFileDetail` /
 * `HtmlStructurePreview` / `SessionFileMeta` / `SessionFileNotice`（约 890–1285 行）。
 *
 * ## 这个面板解决什么问题
 *
 * 会话里 agent 提到过的每个绝对路径都会在这里列出来，点一下就能看内容 ——
 * 「它到底改了哪个文件」这个问题，在手机上有地方回答了。
 *
 * ## 两条判据照抄源工程，不许"优化"
 *
 * 1. **列表优先用 `deliverables`，没有才退回正则扫出来的引用**。
 *    `deliverables/presented` 是内核**明确**说「这几份是交付物」，比正则扫文本可靠得多；
 *    有交付物时还列别的只会让用户在一堆噪音里找那三份成果。
 * 2. **详情页的分支顺序一字不改**：`loading → outsideRoots → failure → directory →
 *    二进制预览 → tooLarge → preview==null → preview 为空 → 按类型渲染`。
 *    顺序本身携带语义 —— 比如 `outsideRoots` 必须排在 `failure` 前面，因为
 *    「不在授权根内」是服务端的**正常判定**、不是错误，混进错误分支就变成了红色警告。
 *
 * ## 两处平台差异
 *
 * 1. **不画表格**（`HtmlStructurePreview`，源工程自己也是刻意不画的）。
 * 2. **PDF 不内嵌渲染**。源工程用 Android 的 PDF 组件画出来；ArkUI 没有等价能力
 *    （要么拉 WebView，要么引三方库，两者都会把包体与权限需求抬上去）。所以 PDF
 *    走「取出字节 + 提示去『文件』页看」这条路，并如实标注这是**功能降级**。
 *    `BinaryFilePreview` 本身已抽到 `ui/Components.ets`（文件页的编辑器也用同一个），
 *    这里不再自带一份。
 */

import { ChatDeliverable, deliverablesOf } from '../core/ChatPresentation';
import { HtmlBlock, HtmlBlockKind, extractHtmlBlocks } from '../core/HtmlPreview';
import { sessionFileSizeText } from '../core/FileFormat';
import { PreviewKind, previewKindOf } from '../core/PreviewKind';
import { SessionFileRef, sessionFileRefs } from '../core/SessionFileRefs';
import { ChatHistory, ResolvedPath } from '../core/Models';
import { SessionFileOpen } from '../core/HarnessViewModel';
import { BinaryFilePreview } from './Components';
import { MarkdownView } from './ChatMessage';

/** 文本预览最多占的高度：内容再长也不把面板撑爆。 */
const PREVIEW_MAX_HEIGHT_VP: number = 400;

/** 二进制预览的最小占位高度，避免图片还在解码时面板高度跳一下。 */
const BINARY_MIN_HEIGHT_VP: number = 180;

/** 二进制预览的最大高度。 */
const BINARY_MAX_HEIGHT_VP: number = 420;

/**
 * 面板列表的条目来源。
 *
 * 抽成一个纯函数（而不是写在 `aboutToAppear` 里）是为了让「列表为空」这个判据
 * 只算一次：`SessionFilesSheet` 每帧都会读它来决定画列表还是画空态。
 */
export function sessionFileList(history: ChatHistory | null): SessionFileRef[] {
  if (history === null) {
    return [];
  }
  const delivered: ChatDeliverable[] = deliverablesOf(history);
  if (delivered.length > 0) {
    const out: SessionFileRef[] = [];
    for (let i = 0; i < delivered.length; i++) {
      // 交付物必然是「这一份」，所以 count 固定 1、lastSeq 用它的 seq。
      out.push(new SessionFileRef(delivered[i].path, 1, delivered[i].seq, delivered[i].description));
    }
    return out;
  }
  return sessionFileRefs(history.events);
}

/** 一个文件条目：文件名（加粗）+ 说明 + 完整路径（等宽） + 出现次数。 */
@Component
struct SessionFileRow {
  ref: SessionFileRef = new SessionFileRef('', 1, 0);
  onOpen: (path: string) => void = (): void => {};

  /** 文件名：取末段；路径以 `/` 结尾时末段为空，此时回退成完整路径。 */
  private baseName(): string {
    const slash: number = this.ref.path.lastIndexOf('/');
    const name: string = slash < 0 ? this.ref.path : this.ref.path.substring(slash + 1);
    return name.trim().length > 0 ? name : this.ref.path;
  }

  private description(): string {
    const desc: string | null = this.ref.description;
    return desc === null ? '' : desc.trim();
  }

  private countText(): string {
    return `×${this.ref.count}`;
  }

  build() {
    Row() {
      Text('📄')
        .fontSize(16)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))

      Column() {
        Text(this.baseName())
          .fontSize(14)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (this.description().length > 0) {
          Text(this.description())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        Text(this.ref.path)
          .fontSize(11)
          .fontFamily('monospace')
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 12 })

      if (this.ref.count > 1) {
        Text(this.countText())
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 11, bottom: 11 })
    .borderRadius(8)
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      this.onOpen(this.ref.path);
    })
  }
}

/** 列表态：标题 + 说明 + 条目；一条都没有时给空态。 */
@Component
struct SessionFileList {
  history: ChatHistory | null = null;
  onOpen: (path: string) => void = (): void => {};

  private refs(): SessionFileRef[] {
    return sessionFileList(this.history);
  }

  private hasMore(): boolean {
    return this.history !== null && this.history.hasMore;
  }

  build() {
    Column() {
      Text($r('app.string.session_files'))
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text($r('app.string.session_files_subtitle'))
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 4 })

      if (this.refs().length === 0) {
        Column() {
          Text('🗂')
            .fontSize(28)
          Text($r('app.string.session_files_empty'))
            .fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 8 })
        }
        .width('100%')
        .padding({ top: 24, bottom: 24 })
      } else {
        List() {
          ForEach(this.refs(), (ref: SessionFileRef) => {
            ListItem() {
              SessionFileRow({ ref: ref, onOpen: this.onOpen })
            }
          }, (ref: SessionFileRef) => ref.path)

          if (this.hasMore()) {
            ListItem() {
              Text($r('app.string.session_file_partial'))
                .fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .width('100%')
                .padding({ top: 10, bottom: 4 })
            }
          }
        }
        .width('100%')
        .height('72%')
        .margin({ top: 10 })
        .scrollBar(BarState.Auto)
      }
    }
    .width('100%')
    .padding({ left: 22, right: 22, bottom: 28 })
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 一句提示 + 一个图标。
 *
 * 图标用文字符号而不是矢量图：本工程没有引入图标资源（`resources/base/media` 下只有
 * 应用图标），而这几处提示里图标的语义完全由旁边那句话承担，用符号即可，
 * 不必为它加一整套 drawable。
 */
@Component
struct SessionFileNotice {
  icon: string = 'ℹ';
  text: ResourceStr = '';

  build() {
    Row() {
      Text(this.icon)
        .fontSize(18)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      Text(this.text)
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .layoutWeight(1)
        .margin({ left: 10 })
    }
    .width('100%')
    .padding({ top: 18, bottom: 18 })
    .alignItems(VerticalAlign.Top)
  }
}

/** `contentType · size`；两项都拿不到就整行不显示。 */
@Component
struct SessionFileMeta {
  resolved: ResolvedPath = new ResolvedPath();

  private parts(): string[] {
    const out: string[] = [];
    const type: string | null = this.resolved.contentType;
    if (type !== null && type.trim().length > 0) {
      out.push(type);
    }
    const size: number | null = this.resolved.size;
    if (size !== null) {
      out.push(sessionFileSizeText(size));
    }
    return out;
  }

  private line(): string {
    const parts: string[] = this.parts();
    return parts.length === 0 ? '' : parts.join(' · ');
  }

  build() {
    Row() {
      if (this.line().length > 0) {
        Text(this.line())
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
    }
    .width('100%')
    .margin({ top: 10 })
  }
}

/**
 * HTML 结构预览 —— 刻意不画表格、不执行脚本，只把标签流拍平成可读的块。
 *
 * 源工程注释里写明了理由：手机上塞一个宽表格只会让用户横向滑来滑去找不到北，
 * 而给出的正文（标题 / 列表 / 引用 / 代码 / 链接 / 段落）已经足够判断
 * 「这个页面讲了什么」。真正要看原样的，去「文件」页。
 */
@Component
struct HtmlStructurePreview {
  source: string = '';

  private blocks(): HtmlBlock[] {
    return extractHtmlBlocks(this.source);
  }

  private linkText(block: HtmlBlock): string {
    const href: string | null = block.href;
    return href === null ? block.text : `${block.text}  ${href}`;
  }

  @Builder
  blockView(block: HtmlBlock, index: number) {
    if (block.kind === HtmlBlockKind.HEADING) {
      Text(block.text)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .width('100%')
    } else if (block.kind === HtmlBlockKind.LIST_ITEM) {
      Row() {
        Text('· ')
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text(block.text)
          .fontSize(12)
          .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
    } else if (block.kind === HtmlBlockKind.QUOTE) {
      Row() {
        Column()
          .width(2)
          .alignSelf(ItemAlign.Stretch)
          .backgroundColor($r('sys.color.ohos_id_color_list_separator'))
        Text(block.text)
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .layoutWeight(1)
          .margin({ left: 8 })
      }
      .width('100%')
    } else if (block.kind === HtmlBlockKind.CODE) {
      Text(block.text)
        .fontSize(12)
        .fontFamily('monospace')
        .padding(8)
        .width('100%')
        .borderRadius(6)
        .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    } else if (block.kind === HtmlBlockKind.LINK) {
      Text(this.linkText(block))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .width('100%')
        .copyOption(CopyOptions.LocalDevice)
    } else {
      Text(block.text)
        .fontSize(12)
        .width('100%')
    }
  }

  build() {
    Column() {
      if (this.blocks().length === 0) {
        // 抽不出块（不是 HTML，或全是脚本）时退回原文 —— 至少内容还在。
        Text(this.source)
          .fontSize(12)
          .fontFamily('monospace')
          .width('100%')
          .copyOption(CopyOptions.LocalDevice)
      } else {
        ForEach(this.blocks(), (block: HtmlBlock, index: number) => {
          this.blockView(block, index)
        }, (block: HtmlBlock, index: number) => `${index}:${block.kind}:${block.text.length}`)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 详情态。
 *
 * `kind` 在 `aboutToAppear` 里算一次即可 —— 它只取决于 `requestedPath` /
 * `contentType` / `bytes`，三者在本次打开期间都不变（切换文件会重建组件）。
 */
@Component
struct SessionFileDetail {
  open: SessionFileOpen = new SessionFileOpen('', '');
  onBack: () => void = (): void => {};
  // 「打开目录」交出的是**已经解析好的**授权根与相对路径，而不是原始绝对路径。
  // 面板里已经有 `open.resolved`（就是 `roots/resolve` 的产物），再让上层拿绝对路径
  // 去解析一遍是白跑一次网络请求；更重要的是两处解析结果可能不一致（目录被移动过）。
  onOpenDirectory: (rootId: string, path: string) => void = (): void => {};

  @State kind: PreviewKind = PreviewKind.SOURCE;

  aboutToAppear(): void {
    const resolved: ResolvedPath | null = this.open.resolved;
    const contentType: string | null = resolved === null ? null : resolved.contentType;
    this.kind = previewKindOf(this.open.requestedPath, contentType, this.open.bytes);
  }

  /**
   * 「打开目录」要的两个值：授权根与相对路径。
   *
   * 写成**返回非空值**的方法（而不是在调用点对 `open.resolved` 连做两次判空）：
   * `@Builder` 里对可空值做两次调用式窄化会报 `10605999 Object is possibly 'null'`
   * （见 PORT-MAP §1b 第八个坑）。按钮只在 `isDirectory()` 为真时渲染，所以这里返回 `''`
   * 只可能出现在"理论上到不了"的路径上，而 `revealDirectory` 对空串是无害的（不会切分节）。
   */
  private resolvedRoot(): string {
    const resolved: ResolvedPath | null = this.open.resolved;
    return resolved === null ? '' : resolved.rootId;
  }

  private resolvedPath(): string {
    const resolved: ResolvedPath | null = this.open.resolved;
    return resolved === null ? '' : resolved.path;
  }

  private isDirectory(): boolean {
    const resolved: ResolvedPath | null = this.open.resolved;
    return resolved !== null && resolved.kind === 'directory';
  }

  private isBinaryPreview(): boolean {
    return this.kind === PreviewKind.IMAGE || this.kind === PreviewKind.PDF;
  }

  /** `PLUGIN_TOO_OLD` 是唯一需要单独文案的失败码：它指向「去电脑上升级插件」这个动作。 */
  private failureText(): ResourceStr {
    const failure: string | null = this.open.failure;
    if (failure === 'PLUGIN_TOO_OLD') {
      return $r('app.string.session_file_plugin_too_old');
    }
    return $r('app.string.session_file_failed', failure === null ? '' : failure);
  }

  private previewIsEmpty(): boolean {
    const preview: string | null = this.open.preview;
    return preview !== null && preview.length === 0;
  }

  private trailingNotice(): ResourceStr {
    return this.open.truncated
      ? $r('app.string.session_file_truncated')
      : $r('app.string.session_file_files_hint');
  }

  @Builder
  previewBody() {
    if (this.kind === PreviewKind.MARKDOWN) {
      MarkdownView({ body: this.open.preview === null ? '' : this.open.preview })
    } else if (this.kind === PreviewKind.HTML) {
      HtmlStructurePreview({ source: this.open.preview === null ? '' : this.open.preview })
    } else {
      // 其余一律等宽原样显示：代码、JSON、日志 —— 折行会让缩进失去意义，
      // 所以给横向滚动。ArkUI 单个 Scroll 只支持一个方向，这里只给横向，
      // 纵向由外层容器承担。
      Scroll() {
        Text(this.open.preview === null ? '' : this.open.preview)
          .fontSize(12)
          .fontFamily('monospace')
          .copyOption(CopyOptions.LocalDevice)
      }
      .scrollable(ScrollDirection.Horizontal)
      .width('100%')
    }
  }

  build() {
    Column() {
      Row() {
        Text('←')
          .fontSize(18)
          .padding({ left: 8, right: 8, top: 4, bottom: 4 })
          .onClick((): void => {
            this.onBack();
          })
        Text($r('app.string.session_file_detail'))
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .margin({ left: 4 })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Text(this.open.requestedPath)
        .fontSize(11)
        .fontFamily('monospace')
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .copyOption(CopyOptions.LocalDevice)

      if (this.open.loading) {
        Column() {
          LoadingProgress()
            .width(24)
            .height(24)
            .color($r('sys.color.ohos_id_color_text_secondary'))
        }
        .width('100%')
        .height(140)
        .justifyContent(FlexAlign.Center)
      } else if (this.open.outsideRoots) {
        // 排在 failure 之前：这是服务端的正常判定，不是错误。
        SessionFileNotice({ icon: '🔒', text: $r('app.string.session_file_outside_roots') })
      } else if (this.open.failure !== null) {
        SessionFileNotice({ icon: '⚠', text: this.failureText() })
      } else if (this.isDirectory()) {
        // 目录给一句说明 + 一个入口：直接切到「文件」页对应目录，比只显示"这是目录"有用。
        Column() {
          SessionFileNotice({ icon: '📁', text: $r('app.string.session_file_directory') })
          Text($r('app.string.session_file_open_directory'))
            .fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .padding({ left: 6, right: 6, top: 4, bottom: 4 })
            .onClick((): void => {
              this.onOpenDirectory(this.resolvedRoot(), this.resolvedPath());
            })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      } else if (this.isBinaryPreview()) {
        Column() {
          if (this.open.resolved !== null) {
            SessionFileMeta({ resolved: this.open.resolved })
          }
          Column() {
            BinaryFilePreview({
              kind: this.kind,
              bytes: this.open.bytes,
              sizeBytes: this.open.resolved === null
                ? 0 : (this.open.resolved.size === null ? 0 : this.open.resolved.size),
              skippedForSize: this.open.tooLarge,
              fallbackMessage: $r('app.string.session_file_binary'),
              skippedHint: $r('app.string.session_file_files_hint'),
            })
          }
          .width('100%')
          .height(BINARY_MIN_HEIGHT_VP)
          .constraintSize({ maxHeight: BINARY_MAX_HEIGHT_VP })
          .margin({ top: 10 })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      } else if (this.open.tooLarge) {
        SessionFileNotice({ icon: '⚠', text: $r('app.string.session_file_too_large') })
      } else if (this.open.preview === null) {
        SessionFileNotice({ icon: '📄', text: $r('app.string.session_file_binary') })
      } else if (this.previewIsEmpty()) {
        SessionFileNotice({ icon: '📄', text: $r('app.string.session_file_empty') })
      } else {
        Column() {
          if (this.open.resolved !== null) {
            SessionFileMeta({ resolved: this.open.resolved })
          }
          Scroll() {
            Column() {
              this.previewBody()
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
          .constraintSize({ maxHeight: PREVIEW_MAX_HEIGHT_VP })
          .margin({ top: 10 })
          .align(Alignment.TopStart)

          Text(this.trailingNotice())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .margin({ top: 10 })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .padding({ left: 22, right: 22, bottom: 28 })
    .alignItems(HorizontalAlign.Start)
  }
}

/** 面板宿主：按 `sessionFileOpen` 是否存在决定画列表还是画详情。 */
@Component
export struct SessionFilesSheet {
  history: ChatHistory | null = null;
  open: SessionFileOpen | null = null;
  sessionId: string | null = null;
  onOpen: (path: string) => void = (): void => {};
  onBack: () => void = (): void => {};
  onOpenDirectory: (rootId: string, path: string) => void = (): void => {};

  /**
   * 打开的结果属于**发起它的那个会话**。
   *
   * 用户在详情页加载途中切到另一个会话时，`sessionFileOpen` 还是旧的 ——
   * 直接渲染会显示上一个会话的文件内容，看起来像"点错了文件"。所以按 sessionId 过滤。
   */
  private current(): SessionFileOpen | null {
    const opened: SessionFileOpen | null = this.open;
    if (opened === null || opened.sessionId !== this.sessionId) {
      return null;
    }
    return opened;
  }

  build() {
    Column() {
      if (this.current() === null) {
        SessionFileList({ history: this.history, onOpen: this.onOpen })
      } else {
        SessionFileDetail({
          open: this.current() as SessionFileOpen,
          onBack: this.onBack,
          onOpenDirectory: this.onOpenDirectory,
        })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
