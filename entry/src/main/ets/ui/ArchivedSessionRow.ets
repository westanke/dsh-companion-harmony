/**
 * 归档视图里的一行 —— 对位源工程 `ui/chat/ChatSessionPane.kt` 的 `ArchivedSessionRow`。
 *
 * ## 刻意**不复用** `SessionRow`
 *
 * 那条行的菜单（重命名 / 分叉 / 归档）对已归档会话要么无意义（再归档一次），
 * 要么本插件不支持（取消归档），复用只会让用户点到无效项。
 * 这里只保留「能打开」这一个动作 —— 归档只是隐藏，会话本身仍然可用。
 *
 * 与源工程同样只做「可点的一行 + 标题」：状态点、工作区副标题一概不给 ——
 * 那些信息属于「这个会话现在在干什么」，而归档视图是回头找历史的场景，不看状态。
 *
 * ## 标题由调用方传入（本组件刻意不算标题）
 *
 * 标题规则（`title ?: workspaceTitle ?: cwd ?: id 前 12 位`）在 `ChatScreen.displayTitleOf`
 * 已经有一份，`SessionRow` 里还私有一份。本组件再抄第三份只会让「改了标题规则漏改一处」
 * 的概率变大 —— 所以由 `ChatScreen` 把算好的标题传进来。
 */

import { ChatSession } from '../core/Models';

@Component
export struct ArchivedSessionRow {
  /**
   * 会话快照 / 标题 / 选中态 / 可操作态**全部**是下行数据，必须 `@Prop`。
   *
   * 与 `SessionRow` 同一个成因：本行也在 `ForEach`（键 = `session.id`）里，键里不含
   * `selected` / `rowEnabled` / 标题，复用实例后普通成员不会回写。见 PORT-MAP 坑 40。
   */
  @Prop session: ChatSession = new ChatSession();
  /** 行标题（由调用方按全工程统一的显示规则算好）。 */
  @Prop title: string = '';
  @Prop selected: boolean = false;
  /**
   * 本行是否可操作。名字**不能**叫 `enabled`：`CustomComponent` 基类已有同名的
   * 通用属性方法（与 `SessionRow` 同一个坑，见该文件注释）。
   */
  @Prop rowEnabled: boolean = true;
  onSelect: (id: string) => void = (): void => {};

  build() {
    Row() {
      Text('💬')
        .fontSize(15)
        .width(36)
        .height(36)
        .textAlign(TextAlign.Center)
        .borderRadius(18)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))

      Text(this.title)
        .fontSize(15)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .margin({ left: 10, right: 4 })
    }
    .width('100%')
    .padding({ left: 6, right: 6, top: 7, bottom: 7 })
    .borderRadius(8)
    .backgroundColor(this.selected
      ? $r('sys.color.ohos_id_color_sub_background')
      : Color.Transparent)
    .alignItems(VerticalAlign.Center)
    .opacity(this.rowEnabled ? 1 : 0.4)
    .onClick((): void => {
      if (this.rowEnabled) {
        this.onSelect(this.session.id);
      }
    })
  }
}
