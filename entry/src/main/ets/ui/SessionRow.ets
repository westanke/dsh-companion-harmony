/**
 * 会话列表里的一行 —— 从 `ui/ChatScreen.ets` 拆出，原因只有一个：**文件行数预算**。
 * `ChatScreen.ets` 原本把「会话分节」的列表、每一行、三个底部面板都装在一个文件里，
 * 超过可维护上限；`SessionRow` 是最独立的一块（只依赖 `ChatSession` 与 `StatusLabel`，
 * 不碰任何 ViewModel 状态），所以先把它整块搬到这里，**代码逐字未改**。
 *
 * 为什么让它单独成组件（而不是 `@Builder`）：它的菜单项（重命名 / 分支 / 归档）各自
 * 绑到本行的实例上，写成独立组件后 `ForEach` 的复用与键控才只作用于这一行 —— 这条
 * 判断原样来自移植时的分析，见下方 `SessionRow` 自带的文档注释。
 */

import { ChatSession } from '../core/Models';
import { StatusLabel } from './Components';

/**
 * 会话列表里的一行。
 *
 * 自成一个组件而不是写成 `@Builder`：它的菜单项（重命名 / 分支 / 归档）各自绑到本行的实例上，
 * 写成独立组件后 `ForEach` 的复用与键控才只作用于这一行。
 */
@Component
export struct SessionRow {
  /**
   * 本行的会话快照。**必须**是 `@Prop`。
   *
   * 这一行由 `ChatScreen` 用 `ForEach`（键 = `session.id`）渲染，而**键里不含**
   * `running` / `pendingInteraction` / `title` / `workspaceTitle` —— 刷新列表时键不变，
   * ArkUI 复用本行实例，普通成员就会一直停在首帧的那份快照上：状态点永远不翻、
   * 重命名后标题不变。与坑 21（`ModelRowView.selected`）完全同型，见 PORT-MAP 坑 40。
   *
   * `@Prop` 会深拷贝，但坑 24 已确证深拷贝保留原型（`Object.setPrototypeOf` + `Object.keys`），
   * 且 `ChatSession` 的字段全是原始类型（见 `core/ModelsChat.ts`），拷贝代价可忽略。
   * 本行只读字段、不比较对象身份，故拷贝不影响「重命名 / 归档」回调（它们只用 `id`）。
   */
  @Prop session: ChatSession = new ChatSession();
  /** 选中高亮。同样是 `ForEach` 复用后不会回写的下行数据（键里没有它）。 */
  @Prop selected: boolean = false;
  /**
   * 本行是否可操作（对应源工程的 `enabled = !state.busy`）。
   *
   * 名字**不能**叫 `enabled`：ArkUI 的 `CustomComponent` 基类上已经有一个
   * 同名的通用属性方法 `enabled(value)`，同名会报
   * 「Property 'enabled' ... is not assignable to the same property in base type」（10505001）。
   */
  @Prop rowEnabled: boolean = true;
  onSelect: (id: string) => void = (): void => {};
  onRename: (session: ChatSession) => void = (): void => {};
  onFork: (id: string) => void = (): void => {};
  onArchive: (session: ChatSession) => void = (): void => {};

  /**
   * 行标题。逐字照抄源工程：
   * `session.title ?: session.workspaceTitle ?: session.cwd.ifBlank { session.id.take(12) }`
   * —— 只有 null 才回退，空串算有值（见文件头第 1 点）。
   */
  private displayTitle(): string {
    const title: string | null = this.session.title;
    if (title !== null) {
      return title;
    }
    const workspaceTitle: string | null = this.session.workspaceTitle;
    if (workspaceTitle !== null) {
      return workspaceTitle;
    }
    const cwd: string = this.session.cwd;
    if (cwd.trim().length > 0) {
      return cwd;
    }
    return this.session.id.length > 12 ? this.session.id.substring(0, 12) : this.session.id;
  }

  /** 副标题：工作区名，且**只在它与主标题不同**时才显示（同源工程 `takeIf { it != displayTitle }`）。 */
  private workspaceSubtitle(): string {
    const workspaceTitle: string | null = this.session.workspaceTitle;
    if (workspaceTitle === null || workspaceTitle === this.displayTitle()) {
      return '';
    }
    return workspaceTitle;
  }

  /** 行右侧「⋮」的菜单项。 */
  private rowMenuItems(): MenuElement[] {
    return [
      {
        value: $r('app.string.rename_session'),
        action: (): void => {
          this.onRename(this.session);
        },
      },
      {
        value: $r('app.string.fork_session'),
        action: (): void => {
          this.onFork(this.session.id);
        },
      },
      {
        value: $r('app.string.archive_session'),
        action: (): void => {
          this.onArchive(this.session);
        },
      },
    ];
  }

  build() {
    Row() {
      Text('💬')
        .fontSize(15)
        .width(36)
        .height(36)
        .textAlign(TextAlign.Center)
        .borderRadius(18)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor(this.selected
          ? $r('sys.color.ohos_id_color_text_primary_activated')
          : $r('sys.color.ohos_id_color_text_secondary'))

      Column() {
        Text(this.displayTitle())
          .fontSize(15)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        Row() {
          if (this.session.pendingInteraction === 'approval') {
            StatusLabel({ label: $r('app.string.approval_pending'), active: true })
          } else {
            StatusLabel({
              label: this.session.running ? $r('app.string.session_running') : $r('app.string.session_idle'),
              active: this.session.running,
            })
          }
          if (this.workspaceSubtitle().length > 0) {
            Text(this.workspaceSubtitle())
              .fontSize(11)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .margin({ left: 8 })
              .layoutWeight(1)
          }
        }
        .margin({ top: 2 })
        .alignItems(VerticalAlign.Center)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 10, right: 4 })

      // 会话操作入口。`bindMenu` 的数据形式挂在点击上；`.enabled(false)` 时整颗菜单不响应，
      // 对应源工程 `IconButton(enabled = !state.busy)`。
      Text('⋮')
        .fontSize(16)
        .padding(8)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .opacity(this.rowEnabled ? 1 : 0.4)
        .enabled(this.rowEnabled)
        .bindMenu(this.rowMenuItems())
    }
    .width('100%')
    .padding({ left: 6, right: 6, top: 7, bottom: 7 })
    .borderRadius(8)
    .backgroundColor(this.selected
      ? $r('sys.color.ohos_id_color_sub_background')
      : Color.Transparent)
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      this.onSelect(this.session.id);
    })
  }
}

