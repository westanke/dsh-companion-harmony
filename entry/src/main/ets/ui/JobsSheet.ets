/**
 * 后台任务面板（会话 ⋯ 菜单 →「后台任务」，bridge ≥ 2.4.3）
 * —— 移植自源工程 `ui/chat/ChatJobsSheet.kt`。
 *
 * ## 这个面板回答什么
 *
 * 远程场景的真焦虑：在手机上让 agent 跑个长任务（构建、批量打包），然后切到别的会话
 * 或者把手机放下 —— 此时**没有任何地方能看到「它还在跑吗」**，更没有地方能「让它停下」。
 * 任务跑飞了只能干等，或者回到电脑前。这个面板就是补这个洞。
 *
 * ## 与 `SessionStatsSheet` 的差别
 *
 * 统计面板是**纯计算**（从已拉取的 `history` 里数数，无网络）；这里是**网络面板**：
 * 打开拉清单、终止要二次确认、输出按需读。数据进 `HarnessState.jobsPanel`（不留在本组件的
 * 局部 state 里），动作走 `HarnessViewModel` —— **本组件一次网络请求都不发**，
 * 这是本项目的架构纪律（见 `docs/PORT-MAP.md` §1）。
 *
 * ## 为什么自己从 `AppRuntime` 读状态，而不是等父组件传进来
 *
 * 面板状态的**唯一数据源**在 vm 的 `state.jobsPanel`，父组件（`ChatHeader`）同样只是读者。
 * 若这里靠父组件传下来的普通成员，一旦「打开 A 会话又关掉、再打开 B 会话」就可能在
 * 参数传递语义上踩空（本项目在 `@Prop` / 普通成员上栽过，见 `ChatHeader.ets` 文件头）。
 * 直接 `@StorageLink('dshRevision') + harnessState()` 与 `ChatHeaderPanelHost` **同一套读法**：
 * 每次 `update()` 递增 revision，本组件跟着重绘，读到的永远是最新值
 * （同一个 `JobsPanelState` 对象就地改）。
 *
 * ## 手动刷新，不做实时推送
 *
 * 服务端就是 REST 读一帧（内核 roster 流首帧即全量），v1 用「刷新」按钮 +
 * 终止后自动刷新。实时推送等 WS 事件通道设计好再说 —— 不要为了「看起来实时」
 * 在手机上挂一个轮询，那是在替用户掏电费。
 */

import { HarnessState, HarnessViewModel, JobView, JobsPanelState } from '../core/HarnessViewModel';
import { jobDurationText } from '../core/JobViews';
import { harnessState, harnessVm } from './AppRuntime';

/** 任务列表的最大高度：超过就内部滚动，面板本身按内容自适应（对位 Compose 默认行为）。 */
const JOB_LIST_MAX_HEIGHT_VP: number = 420;

@Component
export struct JobsSheet {
  /** 自订阅 vm 的 revision，理由同 `ChatHeaderPanelHost.st()`。 */
  @StorageLink('dshRevision') revision: number = 0;
  /** vm 还没装配时的兜底状态，避免 getter 里到处判空。 */
  private fallback: HarnessState = new HarnessState();

  // ————————————————— 基础访问 —————————————————

  private st(): HarnessState {
    // 读一次 revision：ArkUI 只把 **build 期间读过**的状态登记为依赖，只声明不读
    // 的话 vm 更新时本组件不会重绘（见 PORT-MAP §1b 坑 12）。恒真的比较只为让这次读取发生。
    const rev: number = this.revision;
    return rev >= 0 ? (harnessState() ?? this.fallback) : this.fallback;
  }

  private vm(): HarnessViewModel | null {
    return harnessVm();
  }

  private panel(): JobsPanelState | null {
    return this.st().jobsPanel;
  }

  // ————————————————— 取非空展示值（避免 build 里到处判空 / 断言）—————————————————

  private progressText(job: JobView): string {
    return job.progress === null ? '' : job.progress;
  }

  private detailText(job: JobView): string {
    return job.detail === null ? '' : job.detail;
  }

  private isExpanded(job: JobView): boolean {
    const panel: JobsPanelState | null = this.panel();
    return panel !== null && panel.expandedJobId === job.id;
  }

  /** 展开块里要显示的输出正文（还没读回来时为空串，由 `outputLoading` 分支兜住）。 */
  private outputText(): string {
    const panel: JobsPanelState | null = this.panel();
    if (panel === null) {
      return '';
    }
    const output = panel.expandedOutput;
    return output === null ? '' : output.text;
  }

  /**
   * 这段输出是否**被留存策略吃掉过开头**。
   *
   * 必须显式说出来：把一段不完整的输出当成全部展示，用户会拿它判断任务成败 ——
   * 那是拿假数据做真决策（源工程同款注释）。
   */
  private outputLossy(): boolean {
    const panel: JobsPanelState | null = this.panel();
    if (panel === null) {
      return false;
    }
    const output = panel.expandedOutput;
    return output !== null && output.lossy;
  }

  /** 输出是否**读回来了但内容为空**（区别于「还在读」）。 */
  private outputEmpty(): boolean {
    const panel: JobsPanelState | null = this.panel();
    if (panel === null) {
      return false;
    }
    const output = panel.expandedOutput;
    return output !== null && output.text.length === 0;
  }

  /** 状态徽标文案；未知状态兜一句「状态未知」，不硬塞一个看起来确定的值。 */
  private statusRes(status: string): Resource {
    if (status === 'running') {
      return $r('app.string.jobs_status_running');
    }
    if (status === 'stopping') {
      return $r('app.string.jobs_status_stopping');
    }
    if (status === 'completed') {
      return $r('app.string.jobs_status_completed');
    }
    if (status === 'killed') {
      return $r('app.string.jobs_status_killed');
    }
    if (status === 'failed') {
      return $r('app.string.jobs_status_failed');
    }
    return $r('app.string.jobs_status_unknown');
  }

  // ————————————————— 动作 —————————————————

  private refresh(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.loadJobs();
    }
  }

  private toggleOutput(jobId: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.toggleJobOutput(jobId);
    }
  }

  /**
   * 终止前先问一句。**终止是不可撤销的远端动作**，点一下就生效不行；
   * 正文里带上任务名（`label`），用户才知道自己杀的是哪一条。
   */
  private confirmKill(job: JobView): void {
    this.getUIContext().showAlertDialog({
      title: $r('app.string.jobs_kill_confirm_title'),
      // 正文里带上任务名（`label`），用户才知道自己杀的是哪一条。
      message: $r('app.string.jobs_kill_confirm_body', job.label),
      autoCancel: true,
      primaryButton: {
        value: $r('app.string.jobs_kill_confirm_yes'),
        action: (): void => {
          this.kill(job.id);
        },
      },
      secondaryButton: {
        value: $r('app.string.jobs_cancel'),
        action: (): void => {
        },
      },
    });
  }

  private kill(jobId: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.killJob(jobId);
    }
  }

  // ————————————————— 卡片 —————————————————

  @Builder
  jobCard(job: JobView) {
    Column() {
      Row() {
        // label 是生产者给的一行说明（命令行、阶段名），是列表里的主要信息；
        // kind 目前只有 bash，展示价值低，不单独占一行。
        Text(job.label)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(this.statusRes(job.status))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .borderRadius(999)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .margin({ left: 8 })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Row() {
        // 「跑了多久」比绝对时刻有用 —— 远程场景里用户想知道的是「还要等多久」。
        Text(jobDurationText(job, Date.now()))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        if (job.isLive() && job.progress !== null) {
          Text(this.progressText(job))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ left: 10 })
        }
      }
      .width('100%')
      .margin({ top: 4 })

      if (job.detail !== null) {
        Text(this.detailText(job))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 4 })
      }

      Row() {
        Text(this.isExpanded(job)
          ? $r('app.string.jobs_hide_output')
          : $r('app.string.jobs_view_output'))
          .fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .padding({ left: 6, right: 6, top: 4, bottom: 4 })
          .onClick((): void => {
            this.toggleOutput(job.id);
          })
        if (job.isLive()) {
          // 只有存活中的任务才谈得上终止；终态任务给这个按钮只会让人以为界面坏了。
          Text($r('app.string.jobs_kill'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_alert'))
            .opacity(this.killEnabled() ? 1 : 0.4)
            .padding({ left: 6, right: 6, top: 4, bottom: 4 })
            .margin({ left: 6 })
            .onClick((): void => {
              if (this.killEnabled()) {
                this.confirmKill(job);
              }
            })
        }
      }
      .width('100%')
      .justifyContent(FlexAlign.End)
      .margin({ top: 6 })

      if (this.isExpanded(job)) {
        this.outputBlock()
      }
    }
    .width('100%')
    .padding(12)
    .borderRadius(10)
    .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
    .margin({ top: 8 })
    .alignItems(HorizontalAlign.Start)
  }

  /** 同时只允许一条在终止：并发杀两条会让反馈文案互相覆盖。 */
  private killEnabled(): boolean {
    const panel: JobsPanelState | null = this.panel();
    return panel !== null && panel.killingJobId === null;
  }

  @Builder
  outputBlock() {
    Column() {
      Text($r('app.string.jobs_output_title'))
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      if (this.outputLossy()) {
        Text($r('app.string.jobs_output_lossy'))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_alert'))
          .width('100%')
          .margin({ top: 4 })
      }
      if (this.outputLoading()) {
        Row() {
          LoadingProgress()
            .width(16)
            .height(16)
            .color($r('sys.color.ohos_id_color_text_secondary'))
          Text($r('app.string.jobs_output_title'))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ left: 8 })
        }
        .margin({ top: 6 })
        .alignItems(VerticalAlign.Center)
      } else if (this.outputEmpty()) {
        Text($r('app.string.jobs_output_empty'))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 6 })
      } else {
        Scroll() {
          Text(this.outputText())
            .fontSize(11)
            .fontFamily('monospace')
            .width('100%')
            .copyOption(CopyOptions.LocalDevice)
        }
        .width('100%')
        .constraintSize({ maxHeight: 260 })
        .margin({ top: 6 })
        .align(Alignment.TopStart)
      }
    }
    .width('100%')
    .margin({ top: 8 })
    .alignItems(HorizontalAlign.Start)
  }

  private outputLoading(): boolean {
    const panel: JobsPanelState | null = this.panel();
    return panel !== null && panel.outputLoading;
  }

  // ————————————————— 装配 —————————————————

  build() {
    Column() {
      Row() {
        Text($r('app.string.jobs_title'))
          .fontSize(18)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
        Text($r('app.string.jobs_refresh'))
          .fontSize(14)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .opacity(this.refreshEnabled() ? 1 : 0.4)
          .padding({ left: 6, right: 6, top: 4, bottom: 4 })
          .onClick((): void => {
            if (this.refreshEnabled()) {
              this.refresh();
            }
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.showLoading()) {
        Column() {
          LoadingProgress()
            .width(24)
            .height(24)
            .color($r('sys.color.ohos_id_color_text_secondary'))
          Text($r('app.string.jobs_title'))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 8 })
        }
        .width('100%')
        .height(120)
        .justifyContent(FlexAlign.Center)
      } else if (this.showFatalError()) {
        Text(this.errorText())
          .fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_alert'))
          .width('100%')
          .margin({ top: 10 })
      } else if (this.showEmpty()) {
        Text($r('app.string.jobs_empty'))
          .fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 10 })
      } else if (this.jobs().length > 0) {
        // 「有清单」才渲染列表：`panel === null`（关闭动画进行中）时什么都不渲染，
        // 而不是渲染一个空壳 —— 源工程那里就是 `panel == null -> Unit`。
        Scroll() {
          Column() {
            // 有清单时若刷新失败，**旧清单照常显示**，错误只单独亮一行 ——
            // 把已经拿到的数据丢掉，比不展示错误更让人摸不着头脑。
            if (this.errorText().length > 0) {
              Text(this.errorText())
                .fontSize(11)
                .fontColor($r('sys.color.ohos_id_color_alert'))
                .width('100%')
            }
            if (this.killNoticeText().length > 0) {
              Text(this.killNoticeText())
                .fontSize(11)
                .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                .width('100%')
                .margin({ top: 6 })
            }
            ForEach(this.jobs(), (job: JobView): void => {
              this.jobCard(job);
            }, (job: JobView): string => job.id)
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .constraintSize({ maxHeight: JOB_LIST_MAX_HEIGHT_VP })
        .align(Alignment.TopStart)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 20, right: 20, top: 10, bottom: 24 })
  }

  private jobs(): JobView[] {
    const panel: JobsPanelState | null = this.panel();
    return panel === null ? [] : panel.jobs;
  }

  private errorText(): string {
    const panel: JobsPanelState | null = this.panel();
    if (panel === null) {
      return '';
    }
    return panel.error === null ? '' : panel.error;
  }

  private killNoticeText(): string {
    const panel: JobsPanelState | null = this.panel();
    if (panel === null) {
      return '';
    }
    return panel.killNotice === null ? '' : panel.killNotice;
  }

  /** 还没读到任何清单、正在读 → 转圈（而不是显示「没有任务」）。 */
  private showLoading(): boolean {
    const panel: JobsPanelState | null = this.panel();
    return panel !== null && panel.loading && panel.jobs.length === 0;
  }

  /** 读失败且一条也没有 → 亮错误。**不显示「没有任务」**：那是拿失败谎报空。 */
  private showFatalError(): boolean {
    const panel: JobsPanelState | null = this.panel();
    return panel !== null && panel.error !== null && panel.jobs.length === 0;
  }

  /** 真的没有任务（读成功了、清单为空、也没错误）。 */
  private showEmpty(): boolean {
    const panel: JobsPanelState | null = this.panel();
    return panel !== null && panel.jobs.length === 0 && panel.error === null && !panel.loading;
  }

  private refreshEnabled(): boolean {
    const panel: JobsPanelState | null = this.panel();
    return panel !== null && !panel.loading;
  }
}
