/**
 * 文件分节 —— 移植自原工程 `ui/FilesScreen.kt`（749 行）的
 * `FilesScreen` / `FileBrowser` / `FileRow` / `EditorPane` / `NumberedTextEditor` /
 * `fourMarkdownTypography`（`fileMarkdownTypography`）/ `NewEntryDialog` / `MoveDialog` / `TrashDialog`。
 *
 * ## 这个分节解决什么问题
 *
 * 手机上看、改电脑上的文件：选授权根 → 进目录 → 打开文件 → 直接编辑保存，
 * 外加新建/上传/下载/替换/重命名移动/删进回收站/恢复。
 *
 * ## 四条判据照抄源工程，不许"优化"
 *
 * 1. **权限分工是三个不同的 scope**：进这个分节要 `files.read`（在 `AppShell.sectionEnabled` 里）；
 *    **新建/上传/重命名移动/替换文件**要 `files.write`；**删进回收站/从回收站恢复**要 `files.delete`。
 *    三者不可互相顶替 —— 用 `files.write` 去放行删除，等于让只能写的人能删。
 * 2. **「没根目录」与「目录是空的」是两种状态**，文案不同（`no_roots` / `empty_directory`）：
 *    前者要用户去连接页授权一个目录，后者只是这个目录里没东西。
 * 3. **文件名跑马灯而不是截断**。源工程的注释写得很清楚：这里的文件名经常「又长又前缀雷同」
 *    （几个 `DeepSeek-Harness-companion-v2.2.xx.apk` 截出来一模一样），截断会让用户
 *    **判断不出是哪个文件**。`TextOverflow.MARQUEE` 与 `basicMarquee` 同一条性质：
 *    **只在溢出时才滚**，短名字完全不受影响。
 * 4. **保存按钮的三条闸门**：`text != null`（二进制文件没有可保存的正文）、
 *    `entry.writable`（这个文件本身可写）、`files.write`（这台设备被授权写）。
 *    少任何一条都会给用户一个点下去必然失败的按钮。替换文件同理（额外还要求
 *    `kind == "file"`：目录不能"替换"）。
 *
 * ## 四处平台差异
 *
 * 1. **三个系统对话框（新建 / 重命名移动 / 回收站）合成一个 `bindSheet` 宿主 + `sheetKind`**
 *    （与 `ChatScreen.ets` / `ChatDetail.ets` 同一套做法）：ArkUI 系统弹窗装不下带输入框与
 *    可滚列表的内容，一个宿主只有一个显隐来源，也不会互相打架。
 * 2. **跑马灯用 `TextOverflow.MARQUEE`**（见判据 3）。
 * 3. **双指缩放用 `PinchGesture`**：源工程自己算两指距离；ArkUI 的 `PinchGesture` 直接给
 *    `event.scale`，但它是**从手势开始算的累计值**，所以 `onActionStart` 必须记下当前档位作基准，
 *    否则每帧都会在「基准 × 累计」上打滑。工具条的 `−/重置/＋` 按钮与固定步长一并保留。
 * 4. **`NumberedTextEditor` 的行号栏与编辑器同处一个滚动容器**。源工程是「行号栏跟着编辑器
 *    滚动状态做 offset 偏移」；ArkUI 拿不到另一个 `Scroll` 的实时 offset，所以改成
 *    **行号栏与 `TextArea` 并排放在同一个 `Scroll` 里**，靠**两边的行高（`lineHeight`）
 *    完全一致**来对齐 —— 于是"同步滚动"这个问题从根上不存在了。代价写在下面。
 *
 * ### 行号编辑器的一处已知代价（真机验证点）
 *
 * 为了让行号与代码**逐行对齐**，两边必须用同一个 `lineHeight`；而 `TextArea` 在 ArkUI 里
 * **是会自动折行的**，一旦某行被折成两行，行号就错位。所以这里给 `TextArea` 按「最长行字符数」
 * 算宽度（横向滚动，见 `editorTextWidth`），并在字符数上设了 `LONGEST_LINE_CHAR_CAP` 上限 ——
 * 超过上限的超长单行仍会折行、行号在那一段会错位。这个上限是刻意留的：不设上限时
 * 一份压缩过的 JSON（几十万字符一行）会把宽度撑到布局算不出来。
 */

import { common } from '@kit.AbilityKit';
import { FileEntry, RootView, TrashEntry } from '../core/Models';
import { HarnessState, HarnessViewModel, OpenDocument } from '../core/HarnessViewModel';
import { PreviewKind, previewKind } from '../core/PreviewKind';
import { formatBytes, MAX_FILE_BYTES } from '../core/ChatContentParts';
import { PickFailureKind, PickResult, SaveOutcome, pickFile, saveBytes } from '../platform/Pickers';
import { harnessState, harnessVm } from './AppRuntime';
import { BinaryFilePreview } from './Components';
import { MarkdownView } from './ChatMessage';

/** 面板宿主的三态（`sheetKind` 只在本文件内使用，故用数字常量而非导出枚举）。 */
const SHEET_NEW_ENTRY: number = 0;
const SHEET_MOVE: number = 1;
const SHEET_TRASH: number = 2;

/** 宽屏时左侧目录栏的宽度（对位 `Modifier.width(360.dp)`）。 */
const BROWSER_WIDTH_VP: number = 360;

/** 文字缩放的三条常量，与源工程逐字一致。 */
const MIN_TEXT_SCALE: number = 0.75;
const MAX_TEXT_SCALE: number = 2.5;
const TEXT_SCALE_STEP: number = 0.25;

/** 编辑器基准字号与行高（缩放前的值）：字号对位 `bodyMedium`，行高按等宽字体的舒适值取 20。 */
const EDITOR_FONT_VP: number = 14;
const EDITOR_LINE_VP: number = 20;

/** 编辑器上下留白（与源工程的 `padding(vertical = 12.dp)` 一致）。 */
const EDITOR_PAD_VP: number = 12;

/**
 * 按「最长行字符数」算宽度时的上限。
 *
 * 见文件头「行号编辑器的一处已知代价」：超长单行（压缩过的 JSON 常在十万字符量级）不设上限
 * 会把宽度撑到布局算不出来。400 个字符已经覆盖绝大多数真实代码行。
 */
const LONGEST_LINE_CHAR_CAP: number = 400;

/** 等宽字符宽度的粗略比例：`ch` 在多数等宽字体里约为字号的 0.6 倍，留一点余量给 0.62。 */
const MONO_CHAR_RATIO: number = 0.62;

/** 回收站面板里列表的最大高度（对位 `height(360.dp)`）。 */
const TRASH_LIST_MAX_HEIGHT_VP: number = 360;

/** 文件名是否为 Markdown（对位源工程 `isMarkdown`，后缀集合一字不改）。 */
function isMarkdown(name: string): boolean {
  const dot: number = name.lastIndexOf('.');
  const ext: string = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return ext === 'md' || ext === 'markdown' || ext === 'mdown' || ext === 'mkd';
}

/** 夹在区间内（对位 Kotlin `coerceIn`）。 */
function clampScale(value: number): number {
  if (value < MIN_TEXT_SCALE) {
    return MIN_TEXT_SCALE;
  }
  if (value > MAX_TEXT_SCALE) {
    return MAX_TEXT_SCALE;
  }
  return value;
}

/** 空态：一个字形 + 一句话。源工程是 `EmptyState(icon, message)`。 */
@Component
struct EmptyState {
  glyph: string = '';
  label: ResourceStr = '';

  build() {
    Column() {
      Text(this.glyph)
        .fontSize(32)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      Text(this.label)
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .textAlign(TextAlign.Center)
        .margin({ top: 10 })
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .justifyContent(FlexAlign.Center)
  }
}

/**
 * 带行号的纯文本编辑器（对位 `NumberedTextEditor`）。
 *
 * 结构是 `Scroll(纵向) > Scroll(横向) > Row(行号栏 + TextArea)`：两层滚动一次把
 * 「代码块很宽」与「文件很长」都照顾到，且**行号栏与编辑器天然同步**（见文件头差异 4）。
 *
 * 值**直接来自上层**（不在这里留草稿）：源工程的 `BasicTextField` 也是直接绑
 * `state.document.text`，`onValueChange` 就写回 ViewModel。留一份本地草稿反而会出现
 * 「外部把文档换掉了、编辑器还显示旧内容」。
 */
@Component
struct NumberedTextEditor {
  value: string = '';
  /** 文字缩放档位（不叫 `scale`：`scale` 是 ArkUI 通用属性方法名，见 PORT-MAP §1b 坑 7）。 */
  textScale: number = 1;
  onValueChange: (text: string) => void = (): void => {};

  private fontSize(): number {
    return EDITOR_FONT_VP * this.textScale;
  }

  private lineHeight(): number {
    return EDITOR_LINE_VP * this.textScale;
  }

  private lines(): string[] {
    return this.value.split('\n');
  }

  private lineCount(): number {
    return this.lines().length;
  }

  /** 行号栏宽度：对位源工程 `digits * 9 * scale + 22`。 */
  private gutterWidth(): number {
    const digits: number = `${this.lineCount()}`.length;
    return digits * 9 * this.textScale + 22;
  }

  /** 行号文本：从 1 到行数，每行一个。 */
  private gutterText(): string {
    const count: number = this.lineCount();
    const out: string[] = [];
    for (let i = 1; i <= count; i++) {
      out.push(`${i}`);
    }
    return out.join('\n');
  }

  private longestLineChars(): number {
    const lines: string[] = this.lines();
    let max: number = 1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > max) {
        max = lines[i].length;
      }
    }
    return max;
  }

  /**
   * 编辑器宽度：按最长行算，**封顶**（见文件头「已知代价」）。
   *
   * 两侧各留 12vp 内边距（对位 `padding(horizontal = 12.dp)`），末尾再加一个字宽，
   * 免得光标停在最后一列时看不见。
   */
  private editorTextWidth(): number {
    const chars: number = Math.min(this.longestLineChars() + 1, LONGEST_LINE_CHAR_CAP);
    return 24 + chars * this.fontSize() * MONO_CHAR_RATIO;
  }

  /** 整块的高度：行数 × 行高 + 上下留白。**不封顶** —— 纵向滚动由外层 `Scroll` 承担。 */
  private editorHeight(): number {
    return this.lineCount() * this.lineHeight() + EDITOR_PAD_VP * 2;
  }

  build() {
    Scroll() {
      Scroll() {
        Row() {
          // 行号栏。高度与编辑器一致、行高一致，所以逐行对齐。
          Text(this.gutterText())
            .fontSize(this.fontSize())
            .lineHeight(this.lineHeight())
            .fontFamily('monospace')
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .textAlign(TextAlign.End)
            .width(this.gutterWidth())
            .height(this.editorHeight())
            .padding({ top: EDITOR_PAD_VP, right: 8 })
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .alignSelf(ItemAlign.Start)

          TextArea({ text: this.value })
            .fontSize(this.fontSize())
            .lineHeight(this.lineHeight())
            .fontFamily('monospace')
            .width(this.editorTextWidth())
            .height(this.editorHeight())
            .padding({ left: 12, right: 12, top: EDITOR_PAD_VP })
            .backgroundColor(Color.Transparent)
            .borderRadius(0)
            .onChange((text: string): void => {
              this.onValueChange(text);
            })
        }
        .alignItems(VerticalAlign.Top)
      }
      .scrollable(ScrollDirection.Horizontal)
      .align(Alignment.TopStart)
    }
    .scrollable(ScrollDirection.Vertical)
    .width('100%')
    .height('100%')
    .align(Alignment.TopStart)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}

/** 左侧目录浏览器（对位 `FileBrowser`）。 */
@Component
struct FileBrowser {
  onNewFile: () => void = (): void => {};
  onNewFolder: () => void = (): void => {};
  onUpload: () => void = (): void => {};
  onTrash: () => void = (): void => {};

  /**
   * 订阅 vm —— **本结构没有别的重绘途径**：它由 `FilesScreen` 用四个回调构造，
   * 没有任何数据型入参，所以父组件重建时 ArkUI 不会连带重绘它（参数没变）。
   * 少了这一行，点目录、点「上一级」、切授权根都只会改 vm 里的状态而**列表一动不动**——
   * 界面看起来就像点击失灵。这也是本工程所有「直接读 vm 状态的组件」统一带
   * `@StorageLink('dshRevision')` 的原因（`EditorPane` 同理）。
   */
  @StorageLink('dshRevision') revision: number = 0;

  /** vm 还没装配时的兜底状态，避免 getter 里到处判空。 */
  private fallback: HarnessState = new HarnessState();

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

  private scopes(): string[] {
    const device = this.st().device;
    return device === null ? [] : device.scopes;
  }

  /** 写权限：新建 / 上传用（见文件头判据 1）。 */
  private canWrite(): boolean {
    return this.scopes().includes('files.write');
  }

  private selectedRootLabel(): string {
    const roots: RootView[] = this.st().roots;
    const id: string | null = this.st().selectedRootId;
    for (let i = 0; i < roots.length; i++) {
      if (roots[i].id === id) {
        return roots[i].label;
      }
    }
    return '';
  }

  /** 授权根下拉：切根会重新读该根的根目录（`selectRoot` 内部已经这么做）。 */
  private rootMenuItems(): MenuElement[] {
    const roots: RootView[] = this.st().roots;
    const out: MenuElement[] = [];
    for (let i = 0; i < roots.length; i++) {
      const root: RootView = roots[i];
      out.push({
        value: root.label,
        action: (): void => {
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null) {
            void vm.selectRoot(root.id);
          }
        },
      });
    }
    return out;
  }

  private createMenuItems(): MenuElement[] {
    return [
      {
        value: $r('app.string.new_file'),
        action: (): void => {
          this.onNewFile();
        },
      },
      {
        value: $r('app.string.new_folder'),
        action: (): void => {
          this.onNewFolder();
        },
      },
    ];
  }

  /**
   * 「上一级」的目标路径：对位 `currentPath.substringBeforeLast('/', "")`。
   *
   * 注意 `""` 是与「根目录」对应的：`currentPath` 为空时空串也是空串（按钮本就该禁用）。
   */
  private parentPath(): string {
    const path: string = this.st().currentPath;
    const slash: number = path.lastIndexOf('/');
    return slash < 0 ? '' : path.substring(0, slash);
  }

  private breadcrumb(): string {
    return `/${this.st().currentPath}`;
  }

  private entries(): FileEntry[] {
    const page = this.st().directory;
    return page === null ? [] : page.entries;
  }

  private hasNextPage(): boolean {
    const page = this.st().directory;
    return page !== null && page.nextCursor !== null;
  }

  @Builder
  entryRow(entry: FileEntry) {
    Row() {
      Text(entry.kind === 'directory' ? '📁' : '📄')
        .fontSize(19)
        .width(40)
        .height(40)
        .textAlign(TextAlign.Center)
        .borderRadius(6)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor(entry.kind === 'directory'
          ? $r('sys.color.ohos_id_color_text_primary_activated')
          : $r('sys.color.ohos_id_color_text_secondary'))

      Column() {
        // 见文件头判据 3：文件名跑马灯而不是截断。
        Text(entry.name)
          .fontSize(14)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.MARQUEE })
          .width('100%')
        Text(entry.kind === 'directory'
          ? $r('app.string.file_kind_directory')
          : this.fileSubtitle(entry))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .maxLines(1)
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 12, right: 4 })

      Text('⋮')
        .fontSize(16)
        .padding(8)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .onClick((): void => {
          // 只是把这一条"选中为操作目标"，真正的动作在右侧编辑器的 ⋯ 菜单里
          // （窄屏时编辑器整页顶上来，动作就在眼前）。
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null) {
            vm.selectEntryForAction(entry);
          }
        })
    }
    .width('100%')
    .padding({ left: 4, right: 4, top: 9, bottom: 9 })
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      const vm: HarnessViewModel | null = this.vm();
      if (vm !== null) {
        void vm.openEntry(entry);
      }
    })
  }

  /** 副标题：`文件 · 1.2 MiB`；参数化资源拿不到字符串时退回纯类型名。 */
  private fileSubtitle(entry: FileEntry): ResourceStr {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return $r('app.string.file_kind_file');
    }
    const kind: string = ctx.resourceManager.getStringSync($r('app.string.file_kind_file').id);
    return `${kind} · ${formatBytes(entry.size)}`;
  }

  build() {
    Column() {
      Text($r('app.string.root_directory'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .padding({ left: 4, top: 12, bottom: 6 })

      Row() {
        // 授权根选择：`bindMenu` 的数据形式（同一个 MenuElement[] 模式，见 ChatScreen 文件头差异 2）。
        Row() {
          Text('📂')
            .fontSize(15)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          Text(this.selectedRootLabel())
            .fontSize(14)
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ left: 8 })
          Text('⌄')
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
        .layoutWeight(1)
        .height(40)
        .padding({ left: 10, right: 10 })
        .borderRadius(8)
        .border({ width: 1, color: $r('sys.color.ohos_id_color_list_separator') })
        .alignItems(VerticalAlign.Center)
        .bindMenu(this.rootMenuItems())

        Text('⟳')
          .fontSize(16)
          .padding(9)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .onClick((): void => {
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null) {
              void vm.loadDirectory();
            }
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 路径条：上一级 / 当前路径 / 新建 / 上传 / 回收站
      Row() {
        Text('↑')
          .fontSize(16)
          .padding(8)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .opacity(this.st().currentPath.length > 0 ? 1 : 0.4)
          .onClick((): void => {
            if (this.st().currentPath.length > 0) {
              const vm: HarnessViewModel | null = this.vm();
              if (vm !== null) {
                void vm.loadDirectory(this.parentPath());
              }
            }
          })
        Text(this.breadcrumb())
          .fontSize(12)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text('＋')
          .fontSize(17)
          .padding(8)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .opacity(this.canWrite() ? 1 : 0.4)
          .enabled(this.canWrite())
          .bindMenu(this.createMenuItems())
        Text('⬆')
          .fontSize(16)
          .padding(8)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .opacity(this.canWrite() ? 1 : 0.4)
          .enabled(this.canWrite())
          .onClick((): void => {
            if (this.canWrite()) {
              this.onUpload();
            }
          })
        Text('🗑')
          .fontSize(16)
          .padding(8)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .onClick((): void => {
            this.onTrash();
          })
      }
      .width('100%')
      .padding({ left: 4, right: 4 })
      .margin({ top: 10 })
      .borderRadius(6)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .alignItems(VerticalAlign.Center)

      if (this.entries().length === 0) {
        Column() {
          EmptyState({ glyph: '📂', label: $r('app.string.empty_directory') })
        }
        .layoutWeight(1)
        .width('100%')
      } else {
        List() {
          ForEach(this.entries(), (entry: FileEntry) => {
            ListItem() {
              this.entryRow(entry)
            }
          }, (entry: FileEntry) => entry.path)

          if (this.hasNextPage()) {
            ListItem() {
              Text($r('app.string.load_more'))
                .fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                .width('100%')
                .textAlign(TextAlign.Center)
                .padding({ top: 10, bottom: 10 })
                .onClick((): void => {
                  const vm: HarnessViewModel | null = this.vm();
                  if (vm !== null) {
                    void vm.loadNextDirectoryPage();
                  }
                })
            }
          }
        }
        .layoutWeight(1)
        .width('100%')
        .padding({ top: 8, bottom: 8 })
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 12, right: 12 })
  }
}

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
struct EditorPane {
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
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
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

/** 文件分节：宽屏左右分栏；窄屏「目录列表 ↔ 编辑器」二选一。 */
@Component
export struct FilesScreen {
  wide: boolean = false;

  @StorageLink('dshRevision') revision: number = 0;

  // ——— 面板宿主（见文件头差异 1） ———
  @State sheetOpen: boolean = false;
  @State sheetKind: number = SHEET_NEW_ENTRY;

  // ——— 新建面板 ———
  @State newEntryDirectory: boolean = false;
  @State nameDraft: string = '';

  // ——— 重命名移动面板 ———
  @State moveDraft: string = '';

  /** vm 还没装配时的兜底状态。 */
  private fallback: HarnessState = new HarnessState();

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

  private hostContext(): common.Context | undefined {
    return this.getUIContext().getHostContext();
  }

  private toast(text: string): void {
    this.getUIContext().getPromptAction().showToast({ message: text });
  }

  /** 无参资源 → 字符串（只在必须拿 string 的场合用：系统 toast、字符串拼接）。 */
  private resText(res: Resource): string {
    const ctx: common.Context | undefined = this.hostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
  }

  private scopes(): string[] {
    const device = this.st().device;
    return device === null ? [] : device.scopes;
  }

  private canDelete(): boolean {
    return this.scopes().includes('files.delete');
  }

  /** 文档操作的目标：`document` 就是"当前选中的文件"（同源工程）。 */
  private selectedDocument(): OpenDocument | null {
    return this.st().document;
  }

  private selectedName(): string {
    const document: OpenDocument | null = this.selectedDocument();
    return document === null ? '' : document.entry.name;
  }

  private selectedPath(): string {
    const document: OpenDocument | null = this.selectedDocument();
    return document === null ? '' : document.entry.path;
  }

  private openSheet(kind: number): void {
    this.sheetKind = kind;
    this.sheetOpen = true;
  }

  private closeSheet(): void {
    this.sheetOpen = false;
  }

  private openNewEntry(directory: boolean): void {
    this.newEntryDirectory = directory;
    this.nameDraft = '';
    this.openSheet(SHEET_NEW_ENTRY);
  }

  private openMove(): void {
    this.moveDraft = this.selectedPath();
    this.openSheet(SHEET_MOVE);
  }

  private openTrash(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.loadTrash();
    }
    this.openSheet(SHEET_TRASH);
  }

  private confirmNewEntry(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null || this.nameDraft.trim().length === 0) {
      return;
    }
    void vm.createEntry(this.nameDraft, this.newEntryDirectory);
    this.closeSheet();
  }

  private confirmMove(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null || this.moveDraft.trim().length === 0) {
      return;
    }
    void vm.moveSelected(this.moveDraft);
    this.closeSheet();
  }

  // ——— 四个「选文件再交给后端」的动作 ———

  /** 上传新文件：先选文件，再把字节交给 `upload`（文件名取选择器给的）。 */
  private async pickUpload(): Promise<void> {
    const ctx: common.Context | undefined = this.hostContext();
    const vm: HarnessViewModel | null = this.vm();
    if (ctx === undefined || vm === null) {
      return;
    }
    const result: PickResult = await pickFile(ctx, MAX_FILE_BYTES);
    if (result.failure === PickFailureKind.CANCELLED) {
      return;
    }
    if (result.failure !== null || result.file === null) {
      this.toast(this.resText($r('app.string.attachment_read_failed')));
      return;
    }
    await vm.upload(result.file.name, result.file.bytes);
  }

  /** 替换当前文件（后端拿 etag 做乐观锁，见 `replaceSelected`）。 */
  private async pickReplace(): Promise<void> {
    const ctx: common.Context | undefined = this.hostContext();
    const vm: HarnessViewModel | null = this.vm();
    if (ctx === undefined || vm === null) {
      return;
    }
    const result: PickResult = await pickFile(ctx, MAX_FILE_BYTES);
    if (result.failure === PickFailureKind.CANCELLED) {
      return;
    }
    if (result.failure !== null || result.file === null) {
      this.toast(this.resText($r('app.string.attachment_read_failed')));
      return;
    }
    await vm.replaceSelected(result.file.bytes);
  }

  /**
   * 下载：先取字节，再走系统保存面板。
   *
   * **取消保存不提示**（与附件选择同一条判据）；字节为空说明文档已经不在（例如切了目录），
   * 这时也只是静默返回 —— 它不是用户做错的事。
   */
  private async downloadSelected(): Promise<void> {
    const ctx: common.Context | undefined = this.hostContext();
    const vm: HarnessViewModel | null = this.vm();
    if (ctx === undefined || vm === null) {
      return;
    }
    const bytes: Uint8Array = await vm.downloadSelected();
    if (bytes.length === 0) {
      return;
    }
    const outcome: SaveOutcome = await saveBytes(ctx, this.selectedName(), bytes);
    if (outcome === SaveOutcome.FAILED) {
      this.toast(this.resText($r('app.string.attachment_read_failed')));
    }
  }

  private deleteSelected(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null && this.canDelete()) {
      void vm.trashSelected();
    }
  }

  private restoreTrash(id: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null && this.canDelete()) {
      void vm.restoreTrash(id);
    }
  }

  private trashEntries(): TrashEntry[] {
    return this.st().trash;
  }

  private sheetHeight(): SheetSize | number {
    return this.sheetKind === SHEET_TRASH ? SheetSize.MEDIUM : 300;
  }

  @Builder
  sheetContent() {
    Column() {
      if (this.sheetKind === SHEET_TRASH) {
        Column() {
          Text($r('app.string.trash'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          if (this.trashEntries().length === 0) {
            Text($r('app.string.no_trash'))
              .fontSize(13)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .width('100%')
              .margin({ top: 14 })
          } else {
            List() {
              ForEach(this.trashEntries(), (item: TrashEntry) => {
                ListItem() {
                  Row() {
                    Text(item.path)
                      .fontSize(13)
                      .layoutWeight(1)
                      .maxLines(2)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .copyOption(CopyOptions.LocalDevice)
                    Text($r('app.string.restore'))
                      .fontSize(13)
                      .padding(8)
                      .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                      .opacity(this.canDelete() ? 1 : 0.4)
                      .enabled(this.canDelete())
                      .onClick((): void => {
                        this.restoreTrash(item.id);
                      })
                  }
                  .width('100%')
                  .padding({ top: 6, bottom: 6 })
                  .alignItems(VerticalAlign.Center)
                }
              }, (item: TrashEntry) => item.id)
            }
            .width('100%')
            .height(TRASH_LIST_MAX_HEIGHT_VP)
            .margin({ top: 6 })
            .scrollBar(BarState.Off)
          }
          Button($r('app.string.close'))
            .type(ButtonType.Capsule)
            .width('100%')
            .height(42)
            .margin({ top: 14 })
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .fontColor($r('sys.color.ohos_id_color_text_primary'))
            .onClick((): void => {
              this.closeSheet();
            })
        }
        .width('100%')
        .height('100%')
        .alignItems(HorizontalAlign.Start)
      } else {
        Column() {
          Text(this.sheetKind === SHEET_NEW_ENTRY
            ? (this.newEntryDirectory ? $r('app.string.new_folder') : $r('app.string.new_file'))
            : $r('app.string.rename_move'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .width('100%')

          if (this.sheetKind === SHEET_NEW_ENTRY) {
            TextInput({ text: this.nameDraft, placeholder: $r('app.string.file_name') })
              .width('100%')
              .margin({ top: 14 })
              .onChange((value: string): void => {
                this.nameDraft = value;
              })
          } else {
            TextInput({ text: this.moveDraft, placeholder: $r('app.string.destination_path') })
              .width('100%')
              .margin({ top: 14 })
              .onChange((value: string): void => {
                this.moveDraft = value;
              })
          }

          Row() {
            Button($r('app.string.close'))
              .type(ButtonType.Capsule)
              .layoutWeight(1)
              .height(42)
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .onClick((): void => {
                this.closeSheet();
              })
            Button(this.sheetKind === SHEET_NEW_ENTRY
              ? $r('app.string.create') : $r('app.string.confirm'))
              .type(ButtonType.Capsule)
              .layoutWeight(1)
              .height(42)
              .margin({ left: 10 })
              .enabled(this.sheetKind === SHEET_NEW_ENTRY
                ? this.nameDraft.trim().length > 0
                : this.moveDraft.trim().length > 0)
              .onClick((): void => {
                if (this.sheetKind === SHEET_NEW_ENTRY) {
                  this.confirmNewEntry();
                } else {
                  this.confirmMove();
                }
              })
          }
          .width('100%')
          .margin({ top: 18 })
        }
        .width('100%')
        .height('100%')
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 18, right: 18, top: 8, bottom: 16 })
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  build() {
    Column() {
      // 判据 2：一个根目录都没有是「还没授权」，与「这个目录是空的」是两件事。
      if (this.st().roots.length === 0) {
        EmptyState({ glyph: '📂', label: $r('app.string.no_roots') })
      } else if (this.wide) {
        Row() {
          Column() {
            FileBrowser({
              onNewFile: (): void => {
                this.openNewEntry(false);
              },
              onNewFolder: (): void => {
                this.openNewEntry(true);
              },
              onUpload: (): void => {
                void this.pickUpload();
              },
              onTrash: (): void => {
                this.openTrash();
              },
            })
          }
          .width(BROWSER_WIDTH_VP)
          .height('100%')

          Divider()
            .vertical(true)
            .strokeWidth(1)
            .color($r('sys.color.ohos_id_color_list_separator'))

          Column() {
            EditorPane({
              onDownload: (): void => {
                void this.downloadSelected();
              },
              onReplace: (): void => {
                void this.pickReplace();
              },
              onMove: (): void => {
                this.openMove();
              },
              onTrash: (): void => {
                this.deleteSelected();
              },
            })
          }
          .layoutWeight(1)
          .height('100%')
        }
        .width('100%')
        .height('100%')
      } else if (this.selectedDocument() === null) {
        // 窄屏：没选中文件时整页是目录列表。
        FileBrowser({
          onNewFile: (): void => {
            this.openNewEntry(false);
          },
          onNewFolder: (): void => {
            this.openNewEntry(true);
          },
          onUpload: (): void => {
            void this.pickUpload();
          },
          onTrash: (): void => {
            this.openTrash();
          },
        })
      } else {
        Column() {
          EditorPane({
            showBack: true,
            onBack: (): void => {
              const vm: HarnessViewModel | null = this.vm();
              if (vm !== null) {
                // 返回目录：把选中文件清掉即可（`loadDirectory` 会顺带刷新目录）。
                vm.selectEntryForAction(new FileEntry());
                void vm.loadDirectory();
              }
            },
            onDownload: (): void => {
              void this.downloadSelected();
            },
            onReplace: (): void => {
              void this.pickReplace();
            },
            onMove: (): void => {
              this.openMove();
            },
            onTrash: (): void => {
              this.deleteSelected();
            },
          })
        }
        .width('100%')
        .height('100%')
      }
    }
    .width('100%')
    .height('100%')
    .bindSheet(this.sheetOpen, this.sheetContent(), {
      height: this.sheetHeight(),
      dragBar: true,
      onDisappear: (): void => {
        this.sheetOpen = false;
      },
    })
  }
}
