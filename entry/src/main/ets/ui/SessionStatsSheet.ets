/**
 * 执行统计面板 —— 移植自源工程 `ui/ChatScreen.kt` 的 `SessionStatsSheet`。
 *
 * ## 这个面板回答什么
 *
 * 「这一轮/这个会话到底跑了多少？」—— 用户排查「是不是卡住了」「为什么这么慢」时，
 * 需要一个可核对的数字，而不是盯着滚动中的消息流猜。
 *
 * ## 为什么只列这些数字（不做 Token 与上下文占用）
 *
 * 源工程的统计面板分三块：执行、Token 用量、上下文占用。后两块需要内核给出 usage 与
 * 上下文占用数据，而本工程的服务端契约里**不可证**（bridge 原样透传内核事件，
 * 历史事件里有没有 usage 字段从本仓库查不到）。按「空结果的来源要验证」这条纪律，
 * 只做能证明的那部分，并在面板底部**明说**缺什么、为什么缺
 * —— 而不是摆一排 `0` 或 `--` 让用户以为"没用量"。
 *
 * 也刻意**不做**「按字符数估算 token」：误差可能成倍，而用户会拿它当真实占用做决策。
 * 一个不可靠的数字比没有数字更坏 —— 它把"不知道"伪装成"知道"。
 *
 * ## 判据都在 `core/SessionStats.ts`，这里只负责排版
 */

import { ChatHistory } from '../core/Models';
import { SessionStats, sessionStatsOf } from '../core/SessionStats';
import { common } from '@kit.AbilityKit';

@Component
export struct SessionStatsSheet {
  /** `null` = 历史还没加载完（显示空态而不是一堆 0）。 */
  history: ChatHistory | null = null;

  /** 无参资源 → 字符串（ArkUI 的 `Text` 能直接吃 `Resource`，但拼接必须给 string）。 */
  private resText(res: Resource): string {
    const context: common.Context | undefined = this.getUIContext().getHostContext();
    if (context === undefined) {
      return '';
    }
    return context.resourceManager.getStringSync(res.id);
  }

  @Builder
  statRow(label: Resource, value: string) {
    Row() {
      Text(label)
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .layoutWeight(1)
      Text(value)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
    }
    .width('100%')
    .padding({ top: 10, bottom: 10 })
  }

  build() {
    Column() {
      Text($r('app.string.session_stats_title'))
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .width('100%')

      // 空态：还没加载 / 一条事件都没有。**不显示一排 0** —— 全零看起来像"统计坏了"，
      // 而真相只是"这个会话还没内容"。
      if (sessionStatsOf(this.history).isEmpty()) {
        Column() {
          Text('📊')
            .fontSize(30)
          Text($r('app.string.session_stats_empty'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 8 })
        }
        .width('100%')
        .padding({ top: 40, bottom: 40 })
      } else {
        this.statRow($r('app.string.stats_turns'), `${this.counts().turns}`)
        this.statRow($r('app.string.stats_assistant'), `${this.counts().assistantMessages}`)
        this.statRow($r('app.string.stats_tools'), `${this.counts().toolCalls}`)
        this.statRow($r('app.string.stats_events'), `${this.counts().events}`)
        // 「数据截至事件 #N」：面板上的每个数字都要能被核对。说明这一个数是**哪一份历史**
        // 数出来的 —— 分页没拉全时，上面的数字自然只是已拉回那部分。
        Text($r('app.string.stats_last_seq', this.lastSeqText()))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 6 })
      }

      // 如实说明缺什么。用户看到这里才会明白"不是漏了，是读不到"。
      Text($r('app.string.stats_token_unknown'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 16 })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 20, right: 20, top: 16, bottom: 24 })
  }

  /** 只算一次（每帧重算会把几百条事件扫两遍）。 */
  private counts(): SessionStats {
    return sessionStatsOf(this.history);
  }

  private lastSeqText(): string {
    const seq: number | null = sessionStatsOf(this.history).lastSeq;
    return seq === null ? '?' : `${seq}`;
  }
}
