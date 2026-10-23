/**
 * 聊天详情页的待办面板（从 `ChatDetail.ets` 拆出，见 `docs/TECH-DEBT.md`）。
 *
 * 只接收 `todos: TodoItem[]` 作为输入，展开态、完成数、图标配色全在内部计算 ——
 * `ChatDetail` 不再持有 `tasksExpanded` 这类纯 UI 状态。
 */

import { TodoItem } from '../core/Models';

@Component
export struct TodoPanel {
  @Prop todos: TodoItem[] = [];
  /** 展开态住在组件内部，不污染装配层。 */
  @State expanded: boolean = true;

  private completedCount(): number {
    let count: number = 0;
    for (let i: number = 0; i < this.todos.length; i++) {
      if (this.todos[i].status === 'completed') {
        count += 1;
      }
    }
    return count;
  }

  private todoGlyph(todo: TodoItem): string {
    if (todo.status === 'completed') {
      return '✓';
    }
    if (todo.status === 'in_progress') {
      return '✎';
    }
    return '○';
  }

  private todoColor(todo: TodoItem): ResourceStr {
    if (todo.status === 'completed') {
      return $r('sys.color.ohos_id_color_text_primary_activated');
    }
    if (todo.status === 'in_progress') {
      return $r('sys.color.ohos_id_color_emphasize');
    }
    return $r('sys.color.ohos_id_color_text_secondary');
  }

  build() {
    Column() {
      Row() {
        Text('✓')
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        Text($r('app.string.current_tasks'))
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
          .margin({ left: 9 })
        Text($r('app.string.task_progress', this.completedCount(), this.todos.length))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text(this.expanded ? '⌃' : '⌄')
          .fontSize(14)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ left: 8 })
      }
      .width('100%')
      .constraintSize({ minHeight: 48 })
      .padding({ left: 14, right: 14, top: 7, bottom: 7 })
      .alignItems(VerticalAlign.Center)
      .onClick((): void => {
        this.expanded = !this.expanded;
      })

      if (this.expanded) {
        Divider()
          .strokeWidth(1)
          .color($r('sys.color.ohos_id_color_list_separator'))
        ForEach(this.todos, (todo: TodoItem, index: number) => {
          Row() {
            Text(this.todoGlyph(todo))
              .fontSize(14)
              .fontColor(this.todoColor(todo))
              .margin({ top: 2 })
            Text(todo.content)
              .fontSize(14)
              .layoutWeight(1)
              .margin({ left: 9 })
              .fontColor(todo.status === 'completed'
                ? $r('sys.color.ohos_id_color_text_secondary')
                : $r('sys.color.ohos_id_color_text_primary'))
          }
          .width('100%')
          .constraintSize({ minHeight: 42 })
          .padding({ left: 14, right: 14, top: 7, bottom: 7 })
          .alignItems(VerticalAlign.Top)
        }, (todo: TodoItem, index: number): string => `${index}:${todo.status}:${todo.content}`)
      }
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(HorizontalAlign.Start)
  }
}
