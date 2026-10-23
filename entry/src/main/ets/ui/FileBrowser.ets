/**
 * 文件浏览器这一侧 —— 从 `ui/FilesScreen.ets` 拆出，装 `EmptyState` /
 * `NumberedTextEditor` / `FileBrowser` 三个结构体。
 *
 * ## 为什么这样拆
 *
 * `FileBrowser` 是左侧目录浏览器，`NumberedTextEditor` 是它域内用来显示/编辑文本的带行号
 * 编辑器，`EmptyState` 是共用的空态组件 —— 三者都属「目录 / 正文」这一侧，放在一起内聚。
 * 其中 `EmptyState` 与 `NumberedTextEditor` 还被 `EditorPane` / `FilesScreen` 引用，
 * `FileBrowser` 被 `FilesScreen` 引用，所以三者都显式 `export`。
 * **成员变量、装饰器、默认值、回调类型与拆分前逐字一致。**
 *
 * ## 本文件用到的两条判据（源文件头「四条判据」）
 *
 * 1. **权限分工是三个不同的 scope**：进这个分节要 `files.read`（在 `AppShell.sectionEnabled` 里）；
 *    **新建/上传/重命名移动/替换文件**要 `files.write`；**删进回收站/从回收站恢复**要 `files.delete`。
 *    三者不可互相顶替 —— 用 `files.write` 去放行删除，等于让只能写的人能删。
 * 3. **文件名跑马灯而不是截断**。源工程的注释写得很清楚：这里的文件名经常「又长又前缀雷同」
 *    （几个 `DeepSeek-Harness-companion-v2.2.xx.apk` 截出来一模一样），截断会让用户
 *    **判断不出是哪个文件**。`TextOverflow.MARQUEE` 与 `basicMarquee` 同一条性质：
 *    **只在溢出时才滚**，短名字完全不受影响。
 *
 * ## 本文件用到的一处平台差异（源文件头「四处平台差异」）
 *
 * 4. **`NumberedTextEditor` 的行号栏与编辑器同处一个滚动容器**。源工程是「行号栏跟着编辑器
 *    滚动状态做 offset 偏移」；ArkUI 拿不到另一个 `Scroll` 的实时 offset，所以改成
 *    **行号栏与 `TextArea` 并排放在同一个 `Scroll` 里**，靠**两边的行高（`lineHeight`）
 *    完全一致**来对齐 —— 于是"同步滚动"这个问题从根上不存在了。代价写在下面。
 *
 * ## 行号编辑器的一处已知代价（真机验证点）
 *
 * 同样的 `lineHeight` 要求 `TextArea` 不折行：一旦某行被折成两行，行号就错位。所以
 * `editorTextWidth()` 按「最长行字符数」算宽度（横向滚动），并在字符数上设了
 * `LONGEST_LINE_CHAR_CAP` 上限（见 `ui/FilesLayout.ts`）—— 超上限的超长单行仍会折行。
 */

import { common } from '@kit.AbilityKit';
import { FileEntry, RootView } from '../core/Models';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { formatBytes } from '../core/ChatContentParts';
import { harnessState, harnessVm, themedPageBgColor } from './AppRuntime';
import { THEME_PALETTE_PAPER } from '../core/ThemePalettes';
import { EDITOR_FONT_VP, EDITOR_LINE_VP, EDITOR_PAD_VP, LONGEST_LINE_CHAR_CAP,
  MONO_CHAR_RATIO } from './FilesLayout';

/** 空态：一个字形 + 一句话。源工程是 `EmptyState(icon, message)`。 */
@Component
export struct EmptyState {
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
export struct NumberedTextEditor {
  value: string = '';
  /** 文字缩放档位（不叫 `scale`：`scale` 是 ArkUI 通用属性方法名，见 PORT-MAP §1b 坑 7）。 */
  textScale: number = 1;
  onValueChange: (text: string) => void = (): void => {};

  /**
   * 订阅配色名 —— 编辑器底色跟随配色主题（方案 A）。直读键而不是隔函数读 revision，
   * 理由见 `AppRuntime.PALETTE_KEY` 的注释。
   */
  @StorageLink('dshPaletteName') paletteName: string = THEME_PALETTE_PAPER;

  /** 编辑器底色：跟随配色页面底色，PAPER 回落系统默认背景（零漂移）。 */
  private pageBg(): ResourceColor {
    return themedPageBgColor(this.getUIContext().getHostContext(), this.paletteName)
      ?? $r('sys.color.ohos_id_color_background');
  }

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
    .backgroundColor(this.pageBg())
  }
}

/** 左侧目录浏览器（对位 `FileBrowser`）。 */
@Component
export struct FileBrowser {
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
