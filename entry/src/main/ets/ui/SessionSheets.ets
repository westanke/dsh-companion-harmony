/**
 * 底部面板的三种面板体 —— 从 `ui/ChatScreen.ets` 拆出的第二块，原因同样是行数预算。
 *
 * ## 这里是全工程唯一允许「结构性变化」的地方
 *
 * 三个面板体原本是宿主 `ChatScreen` 上的 `@Builder`，直接读写宿主的 `@State`；搬进
 * 独立组件后，状态必须**显式传递**，否则会出现「点了没反应 / 数据不更新」的真实缺陷
 * （本工程刚因「普通成员不随父组件重绘回写子组件」修过一个斜杠命令面板缺陷）。
 *
 * ## 状态传参规则（务必遵守）
 *
 * - **面板要回写的数据用 `@Link`**：`newWorkspace` / `workspaceId` / `presetId` /
 *   `renameDraft`。例如重命名输入框的 `onChange` 必须把新值写回 `renameDraft`，单向的
 *   `@Prop` 写不回去，下一帧会被宿主重绘覆盖掉。
 * - **面板只读的数据用 `@Prop`（单向）**：`kind`（面板形态）、`renameIsWorkspace` /
 *   `renameTargetId` —— 它们只由宿主写、面板只读。
 * - **函数 / 回调类型的成员用普通成员**：`@Prop` 不允许函数类型，函数也不需要响应式。
 *   面板显隐的开关 `sheetOpen` 与形态 `sheetKind` 都归宿主所有（它们是 `bindSheet`
 *   与分发的来源），面板要「关闭」或「切到重命名工作区」时，分别通过 `onClose` /
 *   `onRenameWorkspace` 回调请求宿主，不自己改宿主状态。
 *
 * ## 常量为什么在这里
 *
 * 面板形态需要一个分发点，分发写在本组件 `build()`；`SHEET_CREATE` /
 * `SHEET_WORKSPACES` / `SHEET_RENAME` 因此与面板体同住，供宿主 `ChatScreen` 导入复用
 * （两个文件若互相 import 会形成循环依赖，故常量定义在"被导入"的这一侧）。
 */

import { common } from '@kit.AbilityKit';
import { AgentPreset, ChatWorkspace, FileEntry } from '../core/Models';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { harnessState, harnessVm } from './AppRuntime';

/** 底部面板的三种形态。`sheetKind` 只在本文件内使用，故用数字常量而非导出枚举。 */
export const SHEET_CREATE: number = 0;
export const SHEET_WORKSPACES: number = 1;
export const SHEET_RENAME: number = 2;

@Component
export struct SessionSheetBodies {
  /** 当前面板形态：`SHEET_CREATE` / `SHEET_WORKSPACES` / `SHEET_RENAME`，只由宿主写、这里只读。 */
  @Prop kind: number = SHEET_CREATE;

  // ——— 面板会回写的数据：必须 @Link（@Prop 是单向的，写不回宿主） ———
  @Link newWorkspace: boolean;
  @Link workspaceId: string;
  @Link presetId: string;
  @Link renameDraft: string;

  // ——— 面板只读、宿主写的数据：单向 @Prop 即可 ———
  @Prop renameIsWorkspace: boolean;
  @Prop renameTargetId: string;

  /** 请求关闭面板（`sheetOpen` 是 `bindSheet` 的开关，归宿主）。函数类型用普通成员。 */
  onClose: () => void = (): void => {};
  /** 请求把当前已打开的面板切到「重命名工作区」（`sheetKind` / `sheetOpen` 归宿主）。 */
  onRenameWorkspace: (workspace: ChatWorkspace) => void = (): void => {};

  /** 自订阅 vm 的 revision，理由同 `ChatScreen.st()`：只有 build 期间读过才算依赖。 */
  @StorageLink('dshRevision') revision: number = 0;
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

  /** 参数化资源 → 字符串（只在必须拿 string 的场合用：系统弹窗、字符串拼接）。 */
  private fmt1(res: Resource, arg: string | number): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id, arg);
  }

  /** 无参资源 → 字符串。 */
  private resText(res: Resource): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
  }

  private renameTitleRes(): ResourceStr {
    return this.renameIsWorkspace ? $r('app.string.rename_workspace') : $r('app.string.rename_session');
  }

  private onRenameConfirmed(): void {
    const vm: HarnessViewModel | null = this.vm();
    const draft: string = this.renameDraft;
    if (vm !== null && draft.trim().length > 0) {
      if (this.renameIsWorkspace) {
        void vm.renameWorkspace(this.renameTargetId, draft);
      } else {
        void vm.renameSession(this.renameTargetId, draft);
      }
    }
    this.onClose();
  }

  private confirmDeleteWorkspace(workspace: ChatWorkspace): void {
    this.getUIContext().showAlertDialog({
      title: this.resText($r('app.string.remove_workspace_title')),
      message: this.fmt1($r('app.string.remove_workspace_warning'), workspace.title),
      primaryButton: {
        value: this.resText($r('app.string.remove_workspace')),
        action: (): void => {
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null) {
            void vm.deleteWorkspace(workspace.id);
          }
        },
      },
      secondaryButton: {
        value: this.resText($r('app.string.close')),
        action: (): void => {
        },
      },
      cancel: (): void => {
      },
    });
  }

  private workspaceMenuItems(): MenuElement[] {
    const out: MenuElement[] = [];
    const list: ChatWorkspace[] = this.st().chatWorkspaces;
    for (let i = 0; i < list.length; i++) {
      const workspace: ChatWorkspace = list[i];
      out.push({
        value: `${workspace.title}  /${workspace.path}`,
        action: (): void => {
          this.workspaceId = workspace.id;
        },
      });
    }
    return out;
  }

  private rootMenuItems(): MenuElement[] {
    const out: MenuElement[] = [];
    const roots = this.st().roots;
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      out.push({
        value: root.label,
        action: (): void => {
          this.selectRoot(root.id);
        },
      });
    }
    return out;
  }

  private presetMenuItems(): MenuElement[] {
    const out: MenuElement[] = [];
    out.push({
      value: this.resText($r('app.string.server_default')),
      action: (): void => {
        this.presetId = '';
      },
    });
    const presets: AgentPreset[] = this.st().agentPresets;
    for (let i = 0; i < presets.length; i++) {
      const preset: AgentPreset = presets[i];
      const description: string = preset.description ?? '';
      out.push({
        value: description.length > 0 ? `${preset.name} — ${description}` : preset.name,
        enabled: preset.available,
        action: (): void => {
          this.presetId = preset.id;
        },
      });
    }
    return out;
  }

  private selectedWorkspaceLabel(): ResourceStr {
    const list: ChatWorkspace[] = this.st().chatWorkspaces;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === this.workspaceId) {
        return list[i].title;
      }
    }
    return $r('app.string.no_chat_workspaces');
  }

  private selectedRootLabel(): ResourceStr {
    const rootId: string | null = this.st().workspacePickerRootId;
    if (rootId !== null) {
      const roots = this.st().roots;
      for (let i = 0; i < roots.length; i++) {
        if (roots[i].id === rootId) {
          return roots[i].label;
        }
      }
    }
    return $r('app.string.no_roots');
  }

  private selectedPresetLabel(): ResourceStr {
    const presets: AgentPreset[] = this.st().agentPresets;
    for (let i = 0; i < presets.length; i++) {
      if (presets[i].id === this.presetId) {
        return presets[i].name;
      }
    }
    return $r('app.string.server_default');
  }

  private selectRoot(rootId: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.selectWorkspacePickerRoot(rootId);
    }
  }

  /** 目录浏览里只列目录（源工程 `filter { it.kind == "directory" }`）。 */
  private directoryEntries(): FileEntry[] {
    const page = this.st().workspacePickerDirectory;
    if (page === null) {
      return [];
    }
    const out: FileEntry[] = [];
    for (let i = 0; i < page.entries.length; i++) {
      if (page.entries[i].isDirectory()) {
        out.push(page.entries[i]);
      }
    }
    return out;
  }

  /** 上一层路径。对位 `substringBeforeLast('/', "")`：没有分隔符时返回空串。 */
  private parentPathOf(path: string): string {
    const index: number = path.lastIndexOf('/');
    return index < 0 ? '' : path.substring(0, index);
  }

  private goUp(): void {
    const path: string = this.st().workspacePickerPath;
    if (path.length === 0 || this.st().busy) {
      return;
    }
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.loadWorkspacePickerDirectory(this.parentPathOf(path));
    }
  }

  private enterDirectory(entry: FileEntry): void {
    if (this.st().busy) {
      return;
    }
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.loadWorkspacePickerDirectory(entry.path);
    }
  }

  private createButtonLabel(): ResourceStr {
    return this.newWorkspace ? $r('app.string.create_workspace_and_session') : $r('app.string.create_session');
  }

  private canCreate(): boolean {
    if (this.st().busy) {
      return false;
    }
    if (this.newWorkspace) {
      return this.st().workspacePickerRootId !== null && this.st().workspacePickerDirectory !== null;
    }
    return this.workspaceId.length > 0;
  }

  private onCreateConfirmed(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null) {
      return;
    }
    const preset: string | null = this.presetId.length > 0 ? this.presetId : null;
    if (this.newWorkspace) {
      const rootId: string | null = this.st().workspacePickerRootId;
      if (rootId !== null) {
        void vm.createWorkspaceAndSession(rootId, this.st().workspacePickerPath, preset);
      }
    } else {
      void vm.createSession(this.workspaceId, preset);
    }
    this.onClose();
  }

  @Builder
  emptyState(glyph: string, message: ResourceStr) {
    Column() {
      Text(glyph).fontSize(30)
      Text(message)
        .fontSize(13)
        .margin({ top: 8 })
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  pickerHeading(title: ResourceStr) {
    Text(title)
      .fontSize(12)
      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      .width('100%')
      .margin({ top: 14, bottom: 5 })
  }

  /** 分段按钮（互斥二选一）。选中的用强调色描边，未选中的用次级背景。 */
  @Builder
  segment(label: ResourceStr, active: boolean, onPick: () => void) {
    Text(label)
      .fontSize(13)
      .layoutWeight(1)
      .height(36)
      .textAlign(TextAlign.Center)
      .borderRadius(8)
      .backgroundColor(active
        ? $r('sys.color.ohos_id_color_emphasize')
        : $r('sys.color.ohos_id_color_component_normal'))
      .fontColor(active
        ? $r('sys.color.ohos_id_color_foreground_contrary')
        : $r('sys.color.ohos_id_color_text_primary'))
      .onClick(onPick)
  }

  @Builder
  createSheetBody() {
    Column() {
      Text($r('app.string.new_session'))
        .fontSize(20)
        .fontWeight(FontWeight.Medium)

      Row() {
        this.segment($r('app.string.existing_workspace'), !this.newWorkspace, (): void => {
          this.newWorkspace = false;
        })
        this.segment($r('app.string.new_workspace'), this.newWorkspace, (): void => {
          this.newWorkspace = true;
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null && this.st().workspacePickerDirectory === null) {
            void vm.prepareWorkspacePicker();
          }
        })
      }
      .width('100%')
      .margin({ top: 12 })

      Scroll() {
        Column() {
          if (!this.newWorkspace) {
            this.pickerHeading($r('app.string.dhs_workspace'))
            Button() {
              Row() {
                Text('📁').fontSize(14)
                Text(this.selectedWorkspaceLabel())
                  .fontSize(14)
                  .layoutWeight(1)
                  .textAlign(TextAlign.Start)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ left: 8 })
                Text('⌄').fontSize(13)
              }
              .width('100%')
            }
            .type(ButtonType.Normal)
            .width('100%')
            .borderRadius(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .enabled(this.st().chatWorkspaces.length > 0)
            .bindMenu(this.workspaceMenuItems())
          } else {
            this.pickerHeading($r('app.string.authorized_root'))
            Button() {
              Row() {
                Text('📁').fontSize(14)
                Text(this.selectedRootLabel())
                  .fontSize(14)
                  .layoutWeight(1)
                  .textAlign(TextAlign.Start)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ left: 8 })
                Text('⌄').fontSize(13)
              }
              .width('100%')
            }
            .type(ButtonType.Normal)
            .width('100%')
            .borderRadius(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .enabled(this.st().roots.length > 0)
            .bindMenu(this.rootMenuItems())

            this.pickerHeading($r('app.string.workspace_directory'))
            Row() {
              Text('↑')
                .fontSize(15)
                .padding(10)
                .fontColor(this.st().workspacePickerPath.length === 0
                  ? $r('sys.color.ohos_id_color_text_secondary')
                  : $r('sys.color.ohos_id_color_text_primary_activated'))
                .opacity(this.st().busy ? 0.4 : 1)
                .onClick((): void => {
                  this.goUp();
                })
              Text(`/${this.st().workspacePickerPath}`)
                .fontSize(11)
                .layoutWeight(1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            }
            .width('100%')
            .borderRadius(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .alignItems(VerticalAlign.Center)

            if (this.directoryEntries().length === 0) {
              Text($r('app.string.no_subdirectories'))
                .fontSize(11)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .width('100%')
                .padding({ top: 12, bottom: 12 })
            } else {
              List() {
                ForEach(this.directoryEntries(), (entry: FileEntry) => {
                  ListItem() {
                    Row() {
                      Text('📁')
                        .fontSize(15)
                        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                      Text(entry.name)
                        .fontSize(14)
                        .layoutWeight(1)
                        .maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                        .margin({ left: 10 })
                      Text('›')
                        .fontSize(14)
                        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    }
                    .width('100%')
                    .padding({ left: 6, right: 6, top: 7, bottom: 7 })
                    .alignItems(VerticalAlign.Center)
                    .onClick((): void => {
                      this.enterDirectory(entry);
                    })
                  }
                }, (entry: FileEntry) => entry.path)
              }
              .width('100%')
              .height(96)
              .scrollBar(BarState.Off)
            }
          }

          if (this.st().agentPresets.length > 0) {
            this.pickerHeading($r('app.string.agent_mode'))
            Button() {
              Row() {
                Text('🛠').fontSize(14)
                Text(this.selectedPresetLabel())
                  .fontSize(14)
                  .layoutWeight(1)
                  .textAlign(TextAlign.Start)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ left: 8 })
                Text('⌄').fontSize(13)
              }
              .width('100%')
            }
            .type(ButtonType.Normal)
            .width('100%')
            .borderRadius(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .bindMenu(this.presetMenuItems())
          }
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)

      Button(this.createButtonLabel())
        .type(ButtonType.Capsule)
        .width('100%')
        .height(48)
        .margin({ top: 12 })
        .enabled(this.canCreate())
        .onClick((): void => {
          this.onCreateConfirmed();
        })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  workspaceSheetBody() {
    Column() {
      Text($r('app.string.manage_workspaces'))
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
      Text($r('app.string.manage_workspaces_subtitle'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 4, bottom: 10 })

      if (this.st().chatWorkspaces.length === 0) {
        this.emptyState('📁', $r('app.string.no_chat_workspaces'))
      } else {
        List() {
          ForEach(this.st().chatWorkspaces, (workspace: ChatWorkspace) => {
            ListItem() {
              Column() {
                Row() {
                  Text('📁')
                    .fontSize(16)
                    .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                  Column() {
                    Text(workspace.title)
                      .fontSize(14)
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .width('100%')
                    Text(`/${workspace.path}`)
                      .fontSize(11)
                      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .width('100%')
                  }
                  .layoutWeight(1)
                  .alignItems(HorizontalAlign.Start)
                  .margin({ left: 12, right: 8 })

                  Text('✎')
                    .fontSize(16)
                    .padding(8)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .opacity(this.st().busy ? 0.4 : 1)
                    .onClick((): void => {
                      if (!this.st().busy) {
                        this.onRenameWorkspace(workspace);
                      }
                    })
                  Text('🗑')
                    .fontSize(16)
                    .padding(8)
                    .fontColor($r('sys.color.ohos_id_color_alert'))
                    .opacity(this.st().busy ? 0.4 : 1)
                    .onClick((): void => {
                      if (!this.st().busy) {
                        this.confirmDeleteWorkspace(workspace);
                      }
                    })
                }
                .width('100%')
                .padding({ top: 8, bottom: 8 })
                .alignItems(VerticalAlign.Center)
                Divider()
                  .strokeWidth(1)
                  .color($r('sys.color.ohos_id_color_list_separator'))
              }
              .width('100%')
            }
          }, (workspace: ChatWorkspace) => workspace.id)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  renameSheetBody() {
    Column() {
      Text(this.renameTitleRes())
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
      Text($r('app.string.name'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 16 })
      TextInput({ text: this.renameDraft })
        .width('100%')
        .margin({ top: 6 })
        .onChange((value: string): void => {
          this.renameDraft = value;
        })

      Row() {
        Button($r('app.string.cancel'))
          .type(ButtonType.Capsule)
          .layoutWeight(1)
          .height(44)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .onClick((): void => {
            this.onClose();
          })
        Button($r('app.string.confirm'))
          .type(ButtonType.Capsule)
          .layoutWeight(1)
          .height(44)
          .margin({ left: 10 })
          .enabled(this.renameDraft.trim().length > 0)
          .onClick((): void => {
            this.onRenameConfirmed();
          })
      }
      .width('100%')
      .margin({ top: 18 })
    }
    .width('100%')
    .padding({ top: 8 })
  }

  build() {
    Column() {
      if (this.kind === SHEET_CREATE) {
        this.createSheetBody()
      } else if (this.kind === SHEET_WORKSPACES) {
        this.workspaceSheetBody()
      } else {
        this.renameSheetBody()
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 18, right: 18, top: 8, bottom: 16 })
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }
}

