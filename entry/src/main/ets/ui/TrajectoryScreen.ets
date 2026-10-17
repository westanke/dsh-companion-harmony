/**
 * 执行轨迹页 —— 移植自源工程 `ui/ChatScreen.kt` 的 `TrajectoryScreen`。
 *
 * ## 它与会话流的区别（也就是它存在的理由）
 *
 * 会话流是**给人读的**：只留正文、推理摘要、工具摘要，其余折叠或丢弃。
 * 轨迹是**给人查的**：每一轮里到底发生了什么、各花了多久、哪些是工具调用。
 * 「为什么这一步慢」「它到底调了什么」这两个问题，答案只在这个页面里。
 *
 * 所以这里**不做过滤、不做折叠**：不认识的类型也照列（`OTHER`）—— 轨迹页的价值
 * 恰恰在于"把当时发生的都列出来"，隐藏一项就等于让它失去意义。
 *
 * ## 平台差异：全屏用 `bindContentCover` 而不是路由
 *
 * 源工程是一个独立 Composable 目的地，由外层导航承载。本工程的分节切换在 `AppShell`
 * 里（`section` 是外壳的局部 state、没有路由参数可用），为一个只读页面去改外壳的导航
 * 模型不值得。改用 `bindContentCover`：全屏覆盖、返回手势能关，与图片查看器同一套做法
 * （见 PORT-MAP 坑 31）。
 *
 * ## 分组与耗时的判据都在 `core/Trajectory.ts`，这里只负责排版
 */

import { ChatHistory } from '../core/Models';
import {
  TrajectoryNode, TrajectoryNodeKind, TrajectoryTurn, UNKNOWN_TURN, shortDuration, trajectoryOf,
} from '../core/Trajectory';

/** 左侧时间轴的竖线宽度（给节点标记留出视觉对齐的边距）。 */
const RAIL_WIDTH_VP: number = 14;

/** 每个节点的圆点直径。 */
const DOT_SIZE_VP: number = 9;

@Component
export struct TrajectoryScreen {
  /** `null` = 历史还没加载完（显示空态）。 */
  history: ChatHistory | null = null;
  onClose: () => void = (): void => {};

  /** 节点类型的短标签（本地化四处 + 一个不翻译的类型名）。 */
  private kindLabel(kind: TrajectoryNodeKind): string {
    if (kind === TrajectoryNodeKind.USER) {
      return '👤';
    }
    if (kind === TrajectoryNodeKind.ASSISTANT) {
      return '🤖';
    }
    if (kind === TrajectoryNodeKind.TOOL) {
      return '🔧';
    }
    if (kind === TrajectoryNodeKind.DELIVERABLE) {
      return '📦';
    }
    if (kind === TrajectoryNodeKind.TURN_END) {
      return '⏹';
    }
    return '•';
  }

  @Builder
  turnHeader(turn: TrajectoryTurn) {
    Row() {
      Text(`#${turn.turn === UNKNOWN_TURN ? '?' : `${turn.turn}`}`)
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .layoutWeight(1)
      // 耗时取不到（时间戳乱序 / 跨度为 0 / 只有一个节点）就不印 ——
      // 宁可少一段，也不要编一个数（见 `core/Trajectory.ts` 的判据）。
      if (turn.durationMillis() !== null) {
        Text(shortDuration(turn.durationMillis() as number))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
      if (turn.toolCalls() > 0) {
        Text(`${this.toolGlyph()}${turn.toolCalls()}`)
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ left: 10 })
      }
    }
    .width('100%')
    .padding({ top: 16, bottom: 6 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  nodeRow(node: TrajectoryNode) {
    Row() {
      // 左侧时间轴：一条竖线 + 节点圆点。竖线用固定宽度的色块而不是 `Divider`，
      // 让每条目自己长出一段线（条目高度由文字决定，算不出来）。
      Column() {
        Text('')
          .width(1)
          .height('100%')
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      }
      .width(RAIL_WIDTH_VP)
      .height('100%')

      Text(this.kindLabel(node.kind))
        .fontSize(12)
        .margin({ right: 8 })
      Column() {
        Text(this.nodeLabel(node))
          .fontSize(13)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(`#${node.seq}`)
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
      }
      .layoutWeight(1)
    }
    .width('100%')
    .padding({ top: 4, bottom: 4 })
    .alignItems(VerticalAlign.Center)
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

      if (trajectoryOf(this.history).length === 0) {
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
                }, (node: TrajectoryNode): string => `n-${node.seq}-${node.kind}`)
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
            }
          }, (turn: TrajectoryTurn): string => `t-${turn.turn}`)
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 12, right: 16 })
        .scrollBar(BarState.Auto)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .alignItems(HorizontalAlign.Start)
  }

  private turns(): TrajectoryTurn[] {
    return trajectoryOf(this.history);
  }

  /**
   * 节点显示什么：优先**工具名**（工具节点有 `data.name` 才拿到），否则退回**事件类型原名**。
   *
   * 用类型原名而不是「其他」这类笼统词：轨迹页是排查工具，遇到没见过的类型时，
   * 用户要的正是「它到底叫什么」。所以 `core/Trajectory.ts` 把 `eventType` 原样存了下来。
   */
  private nodeLabel(node: TrajectoryNode): string {
    const label: string | null = node.label;
    return label === null ? node.eventType : label;
  }

  private toolGlyph(): string {
    return '🔧 ';
  }
}
