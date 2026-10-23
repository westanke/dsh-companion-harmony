/**
 * 执行轨迹页 —— 移植自源工程 `ui/chat/ChatTrajectorySheet.kt`。
 *
 * ## 它与会话流的区别（也就是它存在的理由）
 *
 * 会话流是**给人读的**：只留正文、推理摘要、工具摘要，其余折叠或丢弃。
 * 轨迹是**给人查的**：每一轮里到底发生了什么、各花了多久、哪些是工具调用。
 * 「为什么这一步慢」「它到底调了什么」这两个问题，答案只在这个页面里。
 *
 * 所以节点**不过滤语义事件**：不认识的类型也照列（`OTHER`），并保留**事件类型原名**
 * （`eventType`）—— 轨迹页是排查工具，遇到没见过的类型时，用户要的正是「它到底叫什么」。
 * 被丢弃的只有实现细节帧（step 边界、内部日志），判据在 `core/Trajectory.ts`。
 *
 * ## 呈现口径完全对齐源工程（2026-10-20 真机反馈「不认识」）
 *
 * 第一版把节点显示成「emoji + 事件原名」，真机上满屏 `job/registered #1492`、
 * `step/start` —— 用户看不懂。源工程的写法是：
 *
 * | 位置 | 内容 |
 * |---|---|
 * | 轮次标题 | 「第 N 轮」/「轮次之间」+「N 个工具调用」+ 耗时 |
 * | 节点行 | 左列 `#seq`（定宽）→ **本地化的类型名**（用户消息 / 助手消息 / 工具调用 …） |
 * | 节点右侧 | 工具名（`data.name`），主色 |
 * | 点节点 | 展开**缩进过的原始 JSON**；没有载荷时显示「（这条事件没有载荷）」 |
 *
 * 事件原名仍然保留：`OTHER` 节点用它当标签（「其他事件」不提供任何信息）。
 *
 * ## 平台差异：全屏用 `bindContentCover` 而不是路由
 *
 * 源工程是一个独立 Composable 目的地，由外层导航承载。本工程的分节切换在 `AppShell`
 * 里（`section` 是外壳的局部 state、没有路由参数可用），为一个只读页面去改外壳的
 * 导航模型不值得。改用 `bindContentCover`：全屏覆盖、返回手势能关，与图片查看器
 * 同一套做法（见 PORT-MAP 坑 31）。
 *
 * ## 为什么自己从 `AppRuntime` 读状态
 *
 * 与 `JobsSheet` / `SessionFilesSheet` 同一套：`bindContentCover` 的 content builder
 * **不随 vm 的 `update()` 重新执行**（坑 52），靠父组件传普通成员会永远停在首帧。
 * 本页自订阅 `@StorageLink('dshRevision')` 并现读 `harnessState()`。
 */

import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { HarnessState } from '../core/HarnessViewModel';
import {
  TrajectoryNode, TrajectoryNodeKind, TrajectoryTurn, UNKNOWN_TURN, prettyPayload,
  shortDuration, trajectoryOf,
} from '../core/Trajectory';
import { harnessState, themedPageBgColor } from './AppRuntime';
import { THEME_PALETTE_PAPER } from '../core/ThemePalettes';

@Component
export struct TrajectoryScreen {
  onClose: () => void = (): void => {};

  /** 自订阅 vm 的 revision（理由见文件头最后一节）。 */
  @StorageLink('dshRevision') revision: number = 0;
  /** 配色名（方案 A）：底色表达式里直读，见 `AppRuntime.PALETTE_KEY` 的注释。 */
  @StorageLink('dshPaletteName') paletteName: string = THEME_PALETTE_PAPER;

  /** vm 还没装配时的兜底状态。 */
  private fallback: HarnessState = new HarnessState();

  /** 当前展开的节点序号；`-1` 表示全部折叠（与源工程「一次只展开一条」一致）。 */
  @State expandedSeq: number = -1;

  /**
   * 状态栏高度（vp）：`bindContentCover` 的内容**不吃安全区**，从屏幕最顶上画。
   *
   * 真机实证：不加这段时标题「轨迹」压在系统时钟上、关闭 `✕` 压在电池图标上，
   * 又难看又危险（电池那片是系统手势区，点下去可能不落到按钮上）。
   * 普通页面不用管这件事 —— 页面会拿到安全区，只有这类系统级模态需要自己让位。
   */
  @State topInset: number = 0;

  aboutToAppear(): void {
    window.getLastWindow(getContext(this)).then((win: window.Window): void => {
      const area: window.AvoidArea = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      this.topInset = px2vp(area.topRect.height);
    }).catch((): void => {
      // 取不到就按 0 处理：顶栏会贴上去，但页面照常可用，不值得为此拦住用户。
    });
  }

  private st(): HarnessState {
    // 读一次 revision：ArkUI 只把 **build 期间读过**的状态登记为依赖（见坑 12）。
    const rev: number = this.revision;
    return rev >= 0 ? (harnessState() ?? this.fallback) : this.fallback;
  }

  private turns(): TrajectoryTurn[] {
    return trajectoryOf(this.st().history);
  }

  /** 参数化资源 → 字符串（「第 N 轮」「N 个工具调用」都要插值）。 */
  private fmt1(res: Resource, arg: string | number): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id, arg);
  }

  /**
   * 节点类型的**本地化**名称 —— 对位源工程 `nodeTypeLabel()`。
   *
   * 这是「不认识」的正面解药：用户看到的是「工具调用」而不是 `tool/call`。
   * 只有 `OTHER` 退回事件原名（见 `nodeLabel()`）——「其他事件」四个字不提供信息。
   */
  private kindRes(kind: TrajectoryNodeKind): Resource {
    if (kind === TrajectoryNodeKind.USER) {
      return $r('app.string.trajectory_user');
    }
    if (kind === TrajectoryNodeKind.ASSISTANT) {
      return $r('app.string.trajectory_assistant');
    }
    if (kind === TrajectoryNodeKind.TOOL) {
      return $r('app.string.trajectory_tool');
    }
    if (kind === TrajectoryNodeKind.DELIVERABLE) {
      return $r('app.string.trajectory_deliverable');
    }
    if (kind === TrajectoryNodeKind.TURN_END) {
      return $r('app.string.trajectory_turn_end');
    }
    return $r('app.string.trajectory_other');
  }

  /**
   * `OTHER` 节点显示事件原名，其余显示本地化类型名。
   *
   * 为什么只给 `OTHER` 开这个口子：`user/message` 这种名字对用户没有意义（「用户消息」
   * 才是），但 `job/registered` 这种**我们不认识**的类型，翻译成「其他事件」等于
   * 把排查线索抹掉 —— 原文才是线索。
   */
  private nodeLabel(node: TrajectoryNode): string {
    if (node.kind !== TrajectoryNodeKind.OTHER) {
      return '';
    }
    return node.eventType;
  }

  @Builder
  turnHeader(turn: TrajectoryTurn) {
    Row() {
      Text(turn.turn === UNKNOWN_TURN
        ? $r('app.string.trajectory_unknown_turn')
        : this.fmt1($r('app.string.trajectory_turn'), turn.turn))
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .layoutWeight(1)
      if (turn.toolCalls() > 0) {
        Text(this.fmt1($r('app.string.trajectory_tools'), turn.toolCalls()))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ right: 8 })
      }
      // 耗时取不到（时间戳乱序 / 跨度为 0 / 只有一个节点）就不印 ——
      // 宁可少一段，也不要编一个数（见 `core/Trajectory.ts` 的判据）。
      if (turn.durationMillis() !== null) {
        Text(shortDuration(turn.durationMillis() as number))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
    }
    .width('100%')
    .padding({ top: 14, bottom: 4 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  nodeRow(node: TrajectoryNode) {
    Column() {
      Row() {
        // 定宽序号列：对位源工程 52.dp，让类型名整齐对齐。
        Text(`#${node.seq}`)
          .width(52)
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text(this.nodeLabel(node).length > 0 ? this.nodeLabel(node) : this.kindRes(node.kind))
          .fontSize(12)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (node.label !== null) {
          Text(node.label as string)
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_emphasize'))
            .margin({ left: 8 })
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ top: 4, bottom: 4 })

      if (this.expandedSeq === node.seq) {
        if (prettyPayload(node.raw) === null) {
          Text($r('app.string.trajectory_no_payload'))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .padding({ top: 4, left: 52, bottom: 4 })
            .textAlign(TextAlign.Start)
        } else {
          // 缩进用 `Blank` 而不是 `margin left`：`width('100%')` 的块再加左外边距会
          // 超出父宽 52vp，右侧内容被裁掉（真机截帧实证）。
          Row() {
            Blank().width(52)
            Text(prettyPayload(node.raw) as string)
              .fontSize(11)
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .layoutWeight(1)
              .padding(10)
              .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
              .borderRadius(6)
              .copyOption(CopyOptions.LocalDevice)
          }
          .width('100%')
          .margin({ top: 4 })
          .alignItems(VerticalAlign.Top)
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .onClick((): void => {
      // 一次只展开一条：展开的 JSON 可能几百行，全部铺开会让整页变成一堵墙。
      this.expandedSeq = this.expandedSeq === node.seq ? -1 : node.seq;
    })
  }

  build() {
    Column() {
      // 顶栏：标题 + 关闭。返回手势由 `bindContentCover` 兜住，但顶栏有按钮更直观。
      Row() {
        Text($r('app.string.trajectory_title'))
          .fontSize(17)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
        Text('✕')
          .fontSize(18)
          .padding(8)
          .onClick((): void => {
            this.onClose();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .alignItems(VerticalAlign.Center)

      if (this.turns().length === 0) {
        Column() {
          Text('🧭')
            .fontSize(34)
          Text($r('app.string.trajectory_empty'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 10 })
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        List() {
          ForEach(this.turns(), (turn: TrajectoryTurn): void => {
            ListItem() {
              Column() {
                this.turnHeader(turn)
                ForEach(turn.nodes, (node: TrajectoryNode): void => {
                  this.nodeRow(node)
                }, (node: TrajectoryNode): string => `n-${node.seq}`)
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
            }
          }, (turn: TrajectoryTurn): string => `t-${turn.turn}`)
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 18, right: 18 })
        .scrollBar(BarState.Auto)
      }
    }
    .width('100%')
    .height('100%')
    // 让开状态栏：cover 内容不吃安全区，见上面的 `topInset`。
    .padding({ top: this.topInset })
    .backgroundColor(themedPageBgColor(this.getUIContext().getHostContext(), this.paletteName)
      ?? $r('sys.color.ohos_id_color_background'))
    .alignItems(HorizontalAlign.Start)
  }
}
