/**
 * 输入框上方的两个补全面板 —— 移植自原工程 `ui/ChatScreen.kt` 的
 * `MentionSuggestions`（2139–2255 行）与 `CommandSuggestions`（2276–2326 行）。
 *
 * ## 谁决定显示、谁决定内容
 *
 * **父组件（`ChatDetail`）决定显示哪一个**：`@` 提及活跃就画 `MentionSuggestions`，
 * 否则画 `CommandSuggestions`（后者内部再判一次"有没有候选"，没有就整块不渲染）。
 * 两个面板**互斥**，与源工程「斜杠优先」的既定顺序一致 —— 见 `core/ComposerSuggestions.ts`。
 *
 * ## 判据都在 core 里，这里只管画
 *
 * 过滤 / 排序 / 限量 / 前缀匹配全在 `core/ComposerSuggestions.ts`（有单测，21 例）；
 * 路径拼接在 `core/MentionQuery.ts`（`absolute`，有单测）。这里不重复任何一条判据 ——
 * 面板可见性那条判据还有第二个消费者（外层抽屉的手势开关），两处共用才不会漂移。
 *
 * ## 与源工程的书写差异
 *
 * 1. **资源 key 返回的是字符串 key，不是 `@StringRes`**：ArkTS 取资源只认编译期字面量，
 *    所以命令描述走这里 `localizedDescription` 的 switch，与 `ChatPresentation` 的既定口径一致。
 * 2. **图标用字形**（📁 / 📄 / ⌘）代替 Material 图标：本工程没有引入图标资源。
 * 3. 渲染高度、最小行高、可滚动这三条**一字不改**：列表必须能滚（否则手势会一路传到外层抽屉），
 *    上限 264vp（面板贴在输入框上方，铺满整屏会把对话顶没）。
 */

import { CommandDescriptor, FileEntry } from '../core/Models';
import { commandSuggestions, mentionMatches } from '../core/ComposerSuggestions';
import { absolute, query } from '../core/MentionQuery';
import { formatBytes } from '../core/ChatContentParts';

/** `@` 候选列表的高度上限（对位源工程 `heightIn(max = 264.dp)`）。 */
const MENTION_LIST_MAX_HEIGHT_VP: number = 264;

/** 面板与药丸之间的间距：两个浮层之间不留缝会糊成一块。 */
const PANEL_GAP_VP: number = 6;

/**
 * `@` 工作目录文件补全 —— 对齐官方「@ 调取当前工作目录文件或文件夹」。
 *
 * 插入的是**绝对路径**（`@/abs/path/to/file `）：会话事件与工具调用里给模型看的都是绝对路径，
 * 相对路径会让模型先猜「相对于谁」，猜错就是一次无效工具调用。目录结尾补 `/` 且**不加空格**
 * （用户大概率要继续往里选下一级），文件补一个空格把这个词结束掉。
 *
 * 没有数据时也显示一条说明，而不是静默什么都不发生：用户打了 `@` 却在等一个永远不出现的列表，
 * 只会以为是卡了。「读不到」与「空目录」必须分清 —— 前者说读不到，后者说这个目录还是空的。
 */
@Component
export struct MentionSuggestions {
  /**
   * 输入框原文（用来算当前查询串）。
   *
   * **必须是 `@Prop`，不能是普通成员**：面板所在的 `else` 分支在「没有提及」时本就存在，
   * 实例在页面加载时就被创建了；父组件重绘时 ArkUI 只把**带 `@Prop` 的成员**写回子组件
   * （编译产物里 `updateStateVars` 的参数只由 `@Prop` 收集，普通成员被跳过），
   * 于是普通成员会永远停在首帧值 —— 面板看着"打不开"就是这个原因。
   */
  @Prop value: string = '';
  /** 会话工作目录的条目；`null` = 还没读到 / 读不到（与 `failed` 一起构成三态）。 */
  @Prop entries: FileEntry[] | null = null;
  /** `entries === null` 时区分「读不到」与「还在读」。 */
  @Prop failed: boolean = false;
  /** 会话工作目录**相对授权根**的形态（用于在条目路径里做前缀替换）。 */
  @Prop cwd: string = '';
  /** 会话工作目录**绝对**的形态（用于拼出真正能用的绝对路径）。 */
  @Prop cwdAbsolute: string | null = null;
  /** 选中一条：回调收到的是**完整待插入文本**（含 `@` 前缀与结尾的 `/` 或空格）。 */
  onSelect: (inserted: string) => void = (): void => {};

  private matches(): FileEntry[] {
    return mentionMatches(this.entries, query(this.value) ?? '');
  }

  /** 这一条要插进输入框的完整文本。拼不出绝对路径时 `absolute` 会降级返回相对根的路径。 */
  private insertedText(entry: FileEntry): string {
    const abs: string = absolute(this.cwdAbsolute, this.cwd, entry.path);
    return `@${abs}${entry.isDirectory() ? '/' : ' '}`;
  }

  private unavailableText(): Resource {
    return this.failed
      ? $r('app.string.workspace_files_unavailable')
      : $r('app.string.workspace_files_loading');
  }

  build() {
    Column() {
      Text($r('app.string.workspace_files'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .padding({ left: 12, right: 12, top: 4, bottom: 4 })

      if (this.entries === null) {
        // null + 未失败 → 还在读；null + 失败 → 读不到。绝不谎报成「空目录」。
        Text(this.unavailableText())
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      } else if (this.matches().length === 0) {
        Text($r('app.string.workspace_files_empty'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      } else {
        // 必须可滚动：不能滚时用户在面板上横划/上划的手势会一路传到外层抽屉。
        List() {
          ForEach(this.matches(), (entry: FileEntry) => {
            ListItem() {
              Row() {
                Text(entry.isDirectory() ? '📁' : '📄')
                  .fontSize(16)
                  .fontColor($r('sys.color.ohos_id_color_text_secondary'))

                Column() {
                  Text(entry.isDirectory() ? `${entry.name}/` : entry.name)
                    .fontSize(14)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                  // 第二行给**相对工作目录的路径**：绝对路径往往太长被截断，
                  // 而用户判断「是不是我要的那个」靠的通常就是中间那几级目录。
                  Text(entry.path)
                    .fontSize(11)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)
                .margin({ left: 10 })

                if (!entry.isDirectory() && entry.size > 0) {
                  Text(formatBytes(entry.size))
                    .fontSize(11)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                }
              }
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .padding({ left: 12, right: 12, top: 6, bottom: 6 })
              .alignItems(VerticalAlign.Center)
              .onClick((): void => {
                this.onSelect(this.insertedText(entry));
              })
            }
          }, (entry: FileEntry) => entry.path)
        }
        .width('100%')
        .constraintSize({ maxHeight: MENTION_LIST_MAX_HEIGHT_VP })
        .scrollBar(BarState.Auto)
      }
    }
    .width('100%')
    .padding({ top: 5, bottom: 5 })
    .margin({ bottom: PANEL_GAP_VP })
    .borderRadius(12)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .border({ width: 1, color: $r('sys.color.ohos_id_color_list_separator') })
  }
}

/**
 * `/` 命令补全 —— 整行以斜杠开头且还没打空白时才出现（命令名是行首语法）。
 *
 * 候选取 `core/ComposerSuggestions.ts` 的 `commandSuggestions`（前缀匹配、最多 5 条）；
 * 选中即把输入框**整行替换**成 `/<名字> `（源工程传的就是 `onValueChange`，不是追加）。
 */
@Component
export struct CommandSuggestions {
  /**
   * 输入框原文。
   *
   * **必须是 `@Prop`**（理由同 `MentionSuggestions`）：空输入时 `mentioning()` 为 false，
   * 这个面板所在的分支从一开始就存在、实例在页面加载时即被创建；普通成员不会被父组件的
   * 重绘写回，`value` 会永远停在 `''`，`commandSuggestions('')` 恒为空 —— 表现就是
   * 「打了 `/` 什么都带不出来」。
   */
  @Prop value: string = '';
  /** 当前会话可用的命令清单（服务端给，顺序不重排）；同 `value`，必须 `@Prop` 才能随会话切换更新。 */
  @Prop commands: CommandDescriptor[] = [];
  /** 选中一条：回调收到的是**整行待替换文本**（`/<名字> `）。 */
  onSelect: (inserted: string) => void = (): void => {};

  private suggestions(): CommandDescriptor[] {
    return commandSuggestions(this.value, this.commands);
  }

  /**
   * 命令描述的中文文案。ArkTS 取资源只认编译期字面量，所以这里是 switch 而不是查表。
   * 认不出的命令返回 null，由 `supportingText` 退回服务端给的描述或参数提示。
   */
  private localizedDescription(name: string): Resource | null {
    if (name === 'compact') {
      return $r('app.string.command_compact_description');
    }
    if (name === 'export') {
      return $r('app.string.command_export_description');
    }
    if (name === 'feedback') {
      return $r('app.string.command_feedback_description');
    }
    if (name === 'goal') {
      return $r('app.string.command_goal_description');
    }
    if (name === 'permission') {
      return $r('app.string.command_permission_description');
    }
    if (name === 'plan') {
      return $r('app.string.command_plan_description');
    }
    return null;
  }

  /**
   * 一行命令下方的说明：本地化文案 → 服务端描述（非空时）→ 参数提示（`参数：xxx`）。
   * 三步的**顺序与源工程一致**：本地化文案优先，其次才看服务端描述，最后才是参数提示。
   */
  private supportingText(command: CommandDescriptor): ResourceStr {
    const localized: Resource | null = this.localizedDescription(command.name);
    if (localized !== null) {
      return localized;
    }
    const description: string = command.description.trim();
    if (description.length > 0) {
      return description;
    }
    const hint: string = command.input === null ? '' : command.input.hint;
    return $r('app.string.command_input_hint', hint);
  }

  build() {
    // 没有候选就整块不渲染（源工程 `AnimatedVisibility(visible = suggestions.isNotEmpty())`）——
    // 那正是「打了 `/zzz` 不再有面板」这条判据的落点。
    if (this.suggestions().length > 0) {
      Column() {
        Text($r('app.string.available_commands'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .padding({ left: 12, right: 12, top: 4, bottom: 4 })

        ForEach(this.suggestions(), (command: CommandDescriptor) => {
          Row() {
            Text('⌘')
              .fontSize(16)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))

            Column() {
              Text(`/${command.name}`)
                .fontSize(14)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
              Text(this.supportingText(command))
                .fontSize(11)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
            .margin({ left: 10 })
          }
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .padding({ left: 12, right: 12, top: 6, bottom: 6 })
          .alignItems(VerticalAlign.Center)
          .onClick((): void => {
            this.onSelect(`/${command.name} `);
          })
        }, (command: CommandDescriptor) => command.name)
      }
      .width('100%')
      .padding({ top: 5, bottom: 5 })
      .margin({ bottom: PANEL_GAP_VP })
      .borderRadius(12)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .border({ width: 1, color: $r('sys.color.ohos_id_color_list_separator') })
    }
  }
}
