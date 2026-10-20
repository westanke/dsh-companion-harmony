/**
 * 文件页右侧编辑器 —— 从 `ui/FilesScreen.ets` 拆出，装 `EditorPane` 结构体。
 *
 * ## 为什么这样拆
 *
 * `EditorPane` 是「打开文件后的预览 / 编辑面板」，体量最大（421 行），又只被 `FilesScreen`
 * 装配引用，单独成文件后 `FilesScreen` 只剩装配逻辑。它复用 `ui/FileBrowser.ets` 里的
 * `EmptyState` / `NumberedTextEditor`，以及 `ChatMessage` 转发的 `MarkdownView`。
 * **成员、装饰器、默认值、回调类型与拆分前逐字一致。**
 *
 * ## 本文件用到的两条判据（源文件头「四条判据」）
 *
 * 3. **文件名跑马灯而不是截断**（表头标题同样用跑马灯：标题比列表项还窄，长文件名更易看不全）。
 * 4. **保存按钮的三条闸门**：`text != null`（二进制文件没有可保存的正文）、
 *    `entry.writable`（这个文件本身可写）、`files.write`（这台设备被授权写）。
 *    少任何一条都会给用户一个点下去必然失败的按钮。替换文件同理（额外还要求
 *    `kind == "file"`：目录不能"替换"）。
 *
 * ## 本文件用到的一处平台差异（源文件头「四处平台差异」）
 *
 * 3. **双指缩放用 `PinchGesture`**：源工程自己算两指距离；ArkUI 的 `PinchGesture` 直接给
 *    `event.scale`，但它是**从手势开始算的累计值**，所以 `onActionStart` 必须记下当前档位作基准，
 *    否则每帧都会在「基准 × 累计」上打滑。工具条的 `−/重置/＋` 按钮与固定步长一并保留。
 */

import { HarnessState, HarnessViewModel, OpenDocument } from '../core/HarnessViewModel';
import { PreviewKind, previewKind } from '../core/PreviewKind';
import { harnessState, harnessVm } from './AppRuntime';
import { BinaryFilePreview } from './Components';
import { MarkdownView } from './ChatMessage';
import { EmptyState, NumberedTextEditor } from './FileBrowser';
import { MIN_TEXT_SCALE, MAX_TEXT_SCALE, TEXT_SCALE_STEP, clampScale, isMarkdown } from './FilesLayout';

/**
 * 右侧编辑器（对位 `EditorPane`）。
 *
 * 每份文档的界面状态（Markdown 预览开关、文字缩放）都要**按文档重置** ——
 * 源工程靠 `remember(document.entry.path)`。ArkUI 没有这个，所以这里自己记
 * `trackedPath`：一旦发现当前文档换了一份，就把这两个状态恢复成新文档的初始值
 * （`markdownPreview = isMarkdown(name)`、`textScale = 1`）。
 * 不这么做的话，从「预览态的 a.md」切到「b.txt」会沿用 Markdown 预览意图，
 * 从上一份 200% 放大的文件切走也会莫名其妙继续放大。
 */
@Component
export struct EditorPane {
  showBack: boolean = false;
  onBack: () => void = (): void => {};
  onDownload: () => void = (): void => {};
  onReplace: () => void = (): void => {};
  onMove: () => void = (): void => {};
  onTrash: () => void = (): void => {};

  @StorageLink('dshRevision') @Watch('onRevision') revision: number = 0;
  /** Markdown 预览态。 */
  @State markdownPreview: boolean = false;
  /** 文字缩放档位。 */
  @State textScale: number = 1;

  /** 上一次同步时的那份文档路径；与当前不同就重置上面两个状态。 */
  private trackedPath: string = '';
  /** 双指缩放的基准档位：`PinchGesture` 给的是**从手势开始算的累计比例**（见文件头差异 3）。 */
  private pinchBase: number = 1;
  /** vm 还没装配时的兜底状态。 */
  private fallback: HarnessState = new HarnessState();

  aboutToAppear(): void {
    this.syncDocumentState();
  }

  onRevision(): void {
    this.syncDocumentState();
  }

  private st(): HarnessState {
    // 读一次 revision：ArkUI 只把 **build 期间读过**的状态登记为依赖
    // （编译器把 build 体包在 `StartGetAccessRecordingFor` … `StopGetAccessRecording` 之间），
    // 只声明 `@StorageLink` 而不读它，vm 更新时这个组件不会重绘。见 PORT-MAP §1b 坑 12。
    // 恒真的比较：存在的意义就是让这次读取发生。
    const rev: number = this.revision;
    return rev >= 0 ? (harnessState() ?? this.fallback) : this.fallback;
  }

  private vm(): HarnessViewModel | null {
    return harnessVm();
  }

  private doc(): OpenDocument | null {
    return this.st().document;
  }

  /** 换了一份文档就把界面状态重置（判据见类注释）。 */
  private syncDocumentState(): void {
    const document: OpenDocument | null = this.doc();
    const path: string = document === null ? '' : document.entry.path;
    if (path === this.trackedPath) {
      return;
    }
    this.trackedPath = path;
    this.markdownPreview = document !== null && isMarkdown(document.entry.name);
    this.textScale = 1;
  }

  private scopes(): string[] {
    const device = this.st().device;
    return device === null ? [] : device.scopes;
  }

  private canWrite(): boolean {
    return this.scopes().includes('files.write');
  }

  private canDelete(): boolean {
    return this.scopes().includes('files.delete');
  }

  private docText(): string {
    const document: OpenDocument | null = this.doc();
    if (document === null || document.text === null) {
      return '';
    }
    return document.text;
  }

  /** 正文与打开时不一致（判据在数据层，见 `OpenDocument.hasUnsavedChanges`）。 */
  private isDirty(): boolean {
    const document: OpenDocument | null = this.doc();
    return document !== null && document.hasUnsavedChanges();
  }

  /** 保存按钮的三条闸门（见文件头判据 4）。 */
  private canSave(): boolean {
    const document: OpenDocument | null = this.doc();
    return document !== null && document.text !== null
      && document.entry.writable && this.canWrite();
  }

  private nameMarquee(): string {
    const document: OpenDocument | null = this.doc();
    return document === null ? '' : document.entry.name;
  }

  private pathLine(): string {
    const document: OpenDocument | null = this.doc();
    return document === null ? '' : document.entry.path;
  }

  private isMarkdownDoc(): boolean {
    const document: OpenDocument | null = this.doc();
    return document !== null && isMarkdown(document.entry.name);
  }

  private hasText(): boolean {
    const document: OpenDocument | null = this.doc();
    return document !== null && document.text !== null;
  }

  /** 预览类型（判据与「会话附件」面板完全同一套：`previewKind` 是纯函数）。 */
  private previewKindOfDoc(): PreviewKind {
    const document: OpenDocument | null = this.doc();
    if (document === null) {
      return PreviewKind.SOURCE;
    }
    return previewKind(document.entry.name, document.contentType);
  }

  private isBinaryPreview(): boolean {
    const kind: PreviewKind = this.previewKindOfDoc();
    return kind === PreviewKind.IMAGE || kind === PreviewKind.PDF;
  }

  private docSizeBytes(): number {
    const document: OpenDocument | null = this.doc();
    return document === null ? 0 : document.entry.size;
  }

  private docSkippedForSize(): boolean {
    const document: OpenDocument | null = this.doc();
    return document !== null && document.skippedForSize;
  }

  /** 目录不给编辑器：源工程直接把这个条目的 `kind` 当提示文案显示。 */
  private emptyKindText(): string {
    const document: OpenDocument | null = this.doc();
    return document === null ? '' : document.entry.kind;
  }

  private zoomPercent(): string {
    return `${Math.round(this.textScale * 100)}%`;
  }

  private applyZoom(factor: number): void {
    if (Number.isFinite(factor) && factor !== 1) {
      this.textScale = clampScale(this.textScale * factor);
    }
  }

  private zoomBy(delta: number): void {
    this.textScale = clampScale(this.textScale + delta);
  }

  private resetZoom(): void {
    this.textScale = 1;
  }

  /** 编辑器 ⋯ 菜单：下载 / 替换 / 重命名移动 / 移入回收站（四项闸门各不相同）。 */
  private actionMenuItems(): MenuElement[] {
    const document: OpenDocument | null = this.doc();
    const isFile: boolean = document !== null && document.entry.kind === 'file';
    return [
      {
        value: $r('app.string.download'),
        enabled: isFile,
        action: (): void => {
          this.onDownload();
        },
      },
      {
        value: $r('app.string.replace_file'),
        enabled: isFile && this.canWrite(),
        action: (): void => {
          this.onReplace();
        },
      },
      {
        value: $r('app.string.rename_move'),
        enabled: this.canWrite(),
        action: (): void => {
          this.onMove();
        },
      },
      {
        value: $r('app.string.move_to_trash'),
        enabled: this.canDelete(),
        action: (): void => {
          this.onTrash();
        },
      },
    ];
  }

  private toggleMarkdownPreview(value: boolean): void {
    this.markdownPreview = value;
  }

  @Builder
  header() {
    Column() {
      Row() {
        if (this.showBack) {
          Text('←')
            .fontSize(18)
            .padding(10)
            .onClick((): void => {
              this.onBack();
            })
        }
        Column() {
          // 标题也比列表项还窄，长文件名更容易看不全，所以同样跑马灯（判据 3）。
          Text(this.nameMarquee())
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.MARQUEE })
            .width('100%')
          Text(this.pathLine())
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: this.showBack ? 0 : 8 })

        if (this.isMarkdownDoc() && this.hasText()) {
          Text('‹›')
            .fontSize(16)
            .padding(9)
            .fontColor(this.markdownPreview
              ? $r('sys.color.ohos_id_color_text_secondary')
              : $r('sys.color.ohos_id_color_text_primary_activated'))
            .onClick((): void => {
              this.toggleMarkdownPreview(false);
            })
          Text('👁')
            .fontSize(15)
            .padding(9)
            .fontColor(this.markdownPreview
              ? $r('sys.color.ohos_id_color_text_primary_activated')
              : $r('sys.color.ohos_id_color_text_secondary'))
            .onClick((): void => {
              this.toggleMarkdownPreview(true);
            })
        }

        Text('💾')
          .fontSize(16)
          .padding(9)
          // 脏状态直接画在保存键上：没改动时是普通图标，一改动立刻变强调色。
          // 这是「用户怎么知道我改了还没存」的第一现场提示（对位源工程 `FilesScreen.kt:502`）。
          .fontColor(this.isDirty()
            ? $r('sys.color.ohos_id_color_text_primary_activated')
            : $r('sys.color.ohos_id_color_text_secondary'))
          .opacity(this.canSave() ? 1 : 0.4)
          .enabled(this.canSave())
          .onClick((): void => {
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null && this.canSave()) {
              void vm.saveDocument();
            }
          })
        Text('⋮')
          .fontSize(16)
          .padding(9)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .bindMenu(this.actionMenuItems())
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: 6, bottom: 6 })
      .alignItems(VerticalAlign.Center)

      // 缩放工具条：只在有正文时出现（二进制、目录都没有"文字"可缩）。
      if (this.hasText()) {
        Row() {
          Text($r('app.string.zoom_out'))
            .fontSize(12)
            .padding({ left: 8, right: 8, top: 6, bottom: 6 })
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .opacity(this.textScale > MIN_TEXT_SCALE ? 1 : 0.4)
            .enabled(this.textScale > MIN_TEXT_SCALE)
            .onClick((): void => {
              this.zoomBy(-TEXT_SCALE_STEP);
            })
          Text(this.zoomPercent())
            .fontSize(13)
            .width(56)
            .textAlign(TextAlign.Center)
          Text($r('app.string.reset_zoom'))
            .fontSize(12)
            .padding({ left: 8, right: 8, top: 6, bottom: 6 })
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .opacity(this.textScale !== 1 ? 1 : 0.4)
            .enabled(this.textScale !== 1)
            .onClick((): void => {
              this.resetZoom();
            })
          Text($r('app.string.zoom_in'))
            .fontSize(12)
            .padding({ left: 8, right: 8, top: 6, bottom: 6 })
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .opacity(this.textScale < MAX_TEXT_SCALE ? 1 : 0.4)
            .enabled(this.textScale < MAX_TEXT_SCALE)
            .onClick((): void => {
              this.zoomBy(TEXT_SCALE_STEP);
            })
        }
        .width('100%')
        .height(46)
        .padding({ left: 8, right: 8 })
        .justifyContent(FlexAlign.End)
        .alignItems(VerticalAlign.Center)
      }

      Divider()
        .strokeWidth(1)
        .color($r('sys.color.ohos_id_color_list_separator'))
    }
    .width('100%')
  }

  build() {
    Column() {
      this.header()

      if (this.doc() === null) {
        EmptyState({ glyph: '📄', label: $r('app.string.select_file') })
      } else if (this.isBinaryPreview()) {
        // 与「会话附件」面板共用同一个组件（见 Components.ets 的类注释）。
        Column() {
          BinaryFilePreview({
            kind: this.previewKindOfDoc(),
            bytes: this.docBytes(),
            sizeBytes: this.docSizeBytes(),
            skippedForSize: this.docSkippedForSize(),
            fallbackMessage: $r('app.string.binary_file'),
            skippedHint: $r('app.string.preview_skipped_hint_download'),
            showDownload: true,
            onDownload: (): void => {
              this.onDownload();
            },
          })
        }
        .layoutWeight(1)
        .width('100%')
      } else if (this.docText().length === 0 && !this.hasText()) {
        // 有字节但不是 UTF-8 文本、也不是图片/PDF：老实说是二进制文件。
        EmptyState({ glyph: '📄', label: $r('app.string.binary_file') })
      } else if (this.entryIsDirectory()) {
        Column() {
          EmptyState({ glyph: '📂', label: this.emptyKindText() })
        }
        .layoutWeight(1)
        .width('100%')
      } else if (this.isMarkdownDoc() && this.markdownPreview) {
        Scroll() {
          Column() {
            // 字号跟着缩放走（源工程 `fileMarkdownTypography(scale)`）。
            MarkdownView({ body: this.docText(), textScale: this.textScale })
          }
          .width('100%')
          .padding({ left: 18, right: 18, top: 14, bottom: 14 })
          .alignItems(HorizontalAlign.Start)
        }
        .layoutWeight(1)
        .width('100%')
        .align(Alignment.TopStart)
        .gesture(this.pinch())
      } else {
        Column() {
          NumberedTextEditor({
            value: this.docText(),
            textScale: this.textScale,
            onValueChange: (text: string): void => {
              const vm: HarnessViewModel | null = this.vm();
              if (vm !== null) {
                vm.updateDocument(text);
              }
            },
          })
        }
        .layoutWeight(1)
        .width('100%')
        .gesture(this.pinch())
      }
    }
    .width('100%')
    .height('100%')
  }

  private docBytes(): Uint8Array | null {
    const document: OpenDocument | null = this.doc();
    return document === null ? null : document.bytes;
  }

  private entryIsDirectory(): boolean {
    const document: OpenDocument | null = this.doc();
    return document !== null && document.entry.kind === 'directory';
  }

  /** 双指缩放（见文件头差异 3）：需要基准档位，否则每帧都在基准上乘累计值、越缩越离谱。 */
  private pinch(): PinchGestureInterface {
    return PinchGesture({ fingers: 2 })
      .onActionStart((): void => {
        this.pinchBase = this.textScale;
      })
      .onActionUpdate((event: GestureEvent): void => {
        const factor: number = event.scale;
        if (Number.isFinite(factor) && factor > 0) {
          this.textScale = clampScale(this.pinchBase * factor);
        }
      });
  }
}
