/**
 * 文件分节 —— 装配层。移植自原工程 `ui/FilesScreen.kt`（749 行）的
 * `FilesScreen` / `FileBrowser` / `FileRow` / `EditorPane` / `NumberedTextEditor` /
 * `fourMarkdownTypography`（`fileMarkdownTypography`）/ `NewEntryDialog` / `MoveDialog` / `TrashDialog`。
 *
 * ## 拆分说明（本文件现在只剩装配）
 *
 * 拆分前这是 1 440 行的一个大文件，按领域分成了四份；**对外接口不变** ——
 * `AppShell.ets` 仍然 `import { FilesScreen } from './FilesScreen'`：
 *
 * | 文件 | 装什么 |
 * |---|---|
 * | `ui/FilesLayout.ts` | 被多个结构体共用的常量与纯函数（`BROWSER_WIDTH_VP`、`MIN/MAX/TEXT_SCALE_STEP`、`EDITOR_*`、`LONGEST_LINE_CHAR_CAP`、`MONO_CHAR_RATIO`、`TRASH_LIST_MAX_HEIGHT_VP`、`isMarkdown`、`clampScale`） |
 * | `ui/FileBrowser.ets` | `EmptyState` + `NumberedTextEditor` + `FileBrowser` |
 * | `ui/EditorPane.ets` | `EditorPane` |
 * | `ui/FilesScreen.ets`（本文件） | `FilesScreen` 装配 + 它独有的面板状态常量 |
 *
 * 末尾按「转发导出」把 `FileBrowser` / `EditorPane` 再导出一次。所有结构体的成员、
 * 装饰器、默认值、回调类型、逻辑与字符串均逐字搬运，**没有任何行为变化**。
 *
 * ## 本文件用到的判据与平台差异（源文件头「四条判据」「四处平台差异」）
 *
 * 2. **「没根目录」与「目录是空的」是两种状态**，文案不同（`no_roots` / `empty_directory`）：
 *    前者要用户去连接页授权一个目录，后者只是这个目录里没东西。
 * 1. **四个系统对话框（新建 / 重命名移动 / 回收站 / 未保存改动）合成一个 `bindSheet` 宿主 +
 *    `sheetKind`**（与 `ChatScreen.ets` / `ChatDetail.ets` 同一套做法）：ArkUI 系统弹窗装不下
 *    带输入框、可滚列表与**三个**出口的内容，一个宿主只有一个显隐来源，也不会互相打架。
 */

import { common } from '@kit.AbilityKit';
import { FileEntry, TrashEntry } from '../core/Models';
import { HarnessState, HarnessViewModel, OpenDocument } from '../core/HarnessViewModel';
import { MAX_FILE_BYTES } from '../core/ChatContentParts';
import { PickFailureKind, PickResult, SaveOutcome, pickFile, saveBytes } from '../platform/Pickers';
import { harnessState, harnessVm } from './AppRuntime';
import { EmptyState, FileBrowser } from './FileBrowser';
import { EditorPane } from './EditorPane';
import { BROWSER_WIDTH_VP, TRASH_LIST_MAX_HEIGHT_VP } from './FilesLayout';

/** 面板宿主的四态（`sheetKind` 只在本文件内使用，故用数字常量而非导出枚举）。 */
const SHEET_NEW_ENTRY: number = 0;
const SHEET_MOVE: number = 1;
const SHEET_TRASH: number = 2;
const SHEET_UNSAVED: number = 3;

/** 文件分节：宽屏左右分栏；窄屏「目录列表 ↔ 编辑器」二选一。 */
@Component
export struct FilesScreen {
  wide: boolean = false;

  @StorageLink('dshRevision') revision: number = 0;
  /**
   * 入口页发来的「弹未保存确认」请求（系统返回键那条路径）。
   * 本页持有 `bindSheet` 宿主，所以面板只能由它开（见 `AppRuntime.UNSAVED_BACK_SEQ_KEY`）。
   */
  @StorageLink('dshUnsavedBackSeq') @Watch('onUnsavedBackRequested') unsavedBackSeq: number = 0;

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

  /** 收到「系统返回键要求弹未保存确认」的请求。 */
  onUnsavedBackRequested(): void {
    if (this.st().document === null) {
      return;
    }
    this.openSheet(SHEET_UNSAVED);
  }

  /** 当前文档改过还没存（判据在数据层，见 `OpenDocument.hasUnsavedChanges`）。 */
  private documentDirty(): boolean {
    const document: OpenDocument | null = this.selectedDocument();
    return document !== null && document.hasUnsavedChanges();
  }

  /** 保存按钮的闸门：正文存在、文件本身可写、这台设备被授权写（与 `EditorPane.canSave` 同一套）。 */
  private documentSavable(): boolean {
    const document: OpenDocument | null = this.selectedDocument();
    return document !== null && document.text !== null
      && document.entry.writable && this.scopes().includes('files.write');
  }

  /**
   * 退出编辑器回目录。
   *
   * 两条离开路径共用它，**都要过未保存确认**：顶栏返回箭头只是其中一条，
   * 若只拦一处，「点箭头就能绕过确认」等于这道确认没做（源工程 `FilesScreen.kt:188` 的原话）。
   */
  private leaveDocument(): void {
    if (this.documentDirty()) {
      this.openSheet(SHEET_UNSAVED);
      return;
    }
    this.closeDocument();
  }

  /** 真的退出编辑器（清掉选中文档并刷新目录）。 */
  private closeDocument(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null) {
      return;
    }
    vm.selectEntryForAction(new FileEntry());
    void vm.loadDirectory();
  }

  /** 「丢弃改动」出口：明确是用户自己选的，所以直接退出，不再追问。 */
  private discardChanges(): void {
    this.closeSheet();
    this.closeDocument();
  }

  /** 「保存」出口：存完**留在编辑器里**（与源工程一致），不替用户决定退出。 */
  private saveThenStay(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.saveDocument();
    }
    this.closeSheet();
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
      if (this.sheetKind === SHEET_UNSAVED) {
        Column() {
          Text($r('app.string.unsaved_changes_title'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          Text($r('app.string.unsaved_changes_message'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .margin({ top: 10 })
          // 三个出口各自的后果写在按钮上，界面不替用户做决定：
          // 保存（留在编辑器）／关闭（留下继续改）／丢弃（丢掉改动回目录）。
          Button($r('app.string.save'))
            .type(ButtonType.Capsule)
            .width('100%')
            .height(42)
            .margin({ top: 18 })
            // 存不了时不亮这个键：亮着点了必然失败，而用户还以为存上了。
            .enabled(this.documentSavable())
            .opacity(this.documentSavable() ? 1 : 0.4)
            .onClick((): void => {
              this.saveThenStay();
            })
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
            Button($r('app.string.discard_changes'))
              .type(ButtonType.Capsule)
              .layoutWeight(1)
              .height(42)
              .margin({ left: 10 })
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .fontColor($r('sys.color.ohos_id_color_alert'))
              .onClick((): void => {
                this.discardChanges();
              })
          }
          .width('100%')
          .margin({ top: 10 })
        }
        .width('100%')
        .height('100%')
        .alignItems(HorizontalAlign.Start)
      } else if (this.sheetKind === SHEET_TRASH) {
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
              // 有未保存改动先问；没有就直接回目录。
              this.leaveDocument();
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

/** 转发导出：这两个组件已挪到别的文件，但**引入方一个字都不用改**（对外接口保持不变）。 */
export { FileBrowser } from './FileBrowser';
export { EditorPane } from './EditorPane';
