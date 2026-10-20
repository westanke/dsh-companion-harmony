/**
 * 界面主状态机 —— **第 7 层：后台任务面板**（从 `HarnessViewModel.ts` 拆出）。
 * 对位源工程 `HarnessJobsViewModel.kt`。
 *
 * ## 为什么需要它
 *
 * 远程场景下有个真焦虑：用户在手机上让 agent 跑个长任务（bash 构建、批量处理），
 * 然后切到别的会话或者放下手机 —— **此时没有任何地方能看到「它还在跑吗」，
 * 更没有地方能「让它停下」**。任务跑飞了只能干等，或者回到电脑前。
 *
 * ## 五个动作
 *
 * 开 / 关面板、读清单、终止（确认框在 UI 层）、展开 / 收起输出、输出读取。
 * v1 **不做「加载更多」**：任务输出是环形缓冲，超限的旧字节内核本来就不留了，
 * 与其给一个按不动的按钮，不如把 `lossy` 标记亮出来明说「这段不完整」；
 * 增量续读的偏移（`JobOutput.next`）留在数据层，真要分段加载时接口是现成的。
 *
 * ## 为什么动作写在本层而不是界面里
 *
 * 与别的清单类动作同一套制度：状态集中在 `HarnessState.jobsPanel`，动作走 vm ——
 * 界面层**不发请求**，是本项目的架构纪律。`withClient` 已把「无连接丢弃留痕」
 * 「代际失效连失败一起丢」做掉，这里不必也不该重写。
 *
 * ## 为什么在最末一层
 *
 * 它只依赖第 1 层的 `withClient` / `update` / `messageOf` / `client`，本可以排在很前；
 * 但继承链是**线性追加**的，排在末梢（所有人之上）改动面最小 —— 没有任何一层
 * 依赖它，插在中间反而要重排它下游各层的 `extends`。链序见 `HarnessViewModel.ts`。
 */

import {
  DshClient,
} from './DshClient';
import {
  JobKillResult,
  JobOutput,
  JobView,
  killWasRequested,
} from './JobViews';
import {
  HarnessState,
  JobsPanelState,
} from './HarnessTypes';
import {
  toastText,
} from './ErrorMessages';
import { HarnessViewModelConnection } from './HarnessViewModelConnection';

export class HarnessViewModelJobs extends HarnessViewModelConnection {
  // ————————————————— 后台任务 —————————————————

  /** 打开面板并立即读清单。`sessionId` 记进状态，终止与输出读取都靠它。 */
  openJobsPanel(sessionId: string): void {
    this.update((s: HarnessState): void => {
      // 整体替换而不是复用旧对象：面板挂在会话维度上，换会话就要换一份，
      // 复用会让新会话看到上一个会话的任务清单。
      s.jobsPanel = new JobsPanelState(sessionId);
    });
    void this.loadJobs();
  }

  /** 关闭面板（清状态）。面板是临时的，残留一份旧会话的任务清单只会误导。 */
  closeJobsPanel(): void {
    if (this.state.jobsPanel === null) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.jobsPanel = null;
    });
  }

  /**
   * （重新）读清单。刷新后**展开状态要存活**：`expandedJobId` 不动，输出按需重读。
   *
   * 清单读失败**不能把面板打成空白页**：保留旧清单（如果有），只把错误亮出来。
   */
  async loadJobs(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const panel: JobsPanelState | null = this.state.jobsPanel;
      if (panel === null) {
        return;
      }
      const sessionId: string = panel.sessionId;
      this.update((s: HarnessState): void => {
        if (s.jobsPanel !== null) {
          s.jobsPanel.loading = true;
          s.jobsPanel.error = null;
        }
      });
      try {
        const jobs: JobView[] = await api.sessionJobs(sessionId);
        this.update((s: HarnessState): void => {
          if (s.jobsPanel !== null) {
            s.jobsPanel.loading = false;
            s.jobsPanel.jobs = jobs;
            s.jobsPanel.error = null;
          }
        });
      } catch (error) {
        const message: string = this.messageOf(error as Object);
        this.update((s: HarnessState): void => {
          if (s.jobsPanel !== null) {
            s.jobsPanel.loading = false;
            s.jobsPanel.error = message;
          }
        });
      }
    });
  }

  /**
   * 终止一条任务。**调用方（UI）负责先弹确认框** —— 这里不做二次确认，
   * 因为确认文案要写清楚对象是谁，只有界面层知道用户点的是哪一条。
   *
   * 成功后立刻刷新清单：状态徽标从「运行中」翻到终态要靠下一次拉取。
   * `already-finished` 与 `requested` 的反馈文案不同（「它已经结束了」vs
   * 「已发送终止请求」），经 `JobsPanelState.killNotice` 亮给用户。
   */
  async killJob(jobId: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const panel: JobsPanelState | null = this.state.jobsPanel;
      if (panel === null) {
        return;
      }
      const sessionId: string = panel.sessionId;
      this.update((s: HarnessState): void => {
        if (s.jobsPanel !== null) {
          s.jobsPanel.killingJobId = jobId;
        }
      });
      try {
        const result: JobKillResult = await api.killJob(sessionId, jobId);
        // 「它已经结束了」不是「已终止」的成功说法：用户在远程场景下看到
        // 这句才知道不用再管了。
        const notice: string = killWasRequested(result.outcome)
          ? toastText('jobs_kill_requested', this.lang())
          : toastText('jobs_kill_already_finished', this.lang());
        this.update((s: HarnessState): void => {
          if (s.jobsPanel !== null) {
            s.jobsPanel.killingJobId = null;
            s.jobsPanel.killNotice = notice;
          }
        });
        await this.loadJobs();
      } catch (error) {
        const message: string = this.messageOf(error as Object);
        this.update((s: HarnessState): void => {
          if (s.jobsPanel !== null) {
            s.jobsPanel.killingJobId = null;
            s.jobsPanel.killNotice = message;
          }
        });
      }
    });
  }

  /**
   * 展开 / 收起一条任务的输出；收起时顺手清掉已读的那份，避免残留上一条的内容。
   *
   * 展开后的读取是**独立异步**（不走 `withClient`）：它不该把全局 busy 掀起来，
   * 也不该抢走 `killJob` 正在跑的代际号。回来时再核对一次 `expandedJobId`，
   * 用户中途收起或换了别条就不再写回 —— 否则会看到「收了半天又自己弹开」。
   */
  toggleJobOutput(jobId: string): void {
    const panel: JobsPanelState | null = this.state.jobsPanel;
    if (panel === null) {
      return;
    }
    if (panel.expandedJobId === jobId) {
      this.update((s: HarnessState): void => {
        if (s.jobsPanel !== null) {
          s.jobsPanel.expandedJobId = null;
          s.jobsPanel.expandedOutput = null;
          s.jobsPanel.outputLoading = false;
        }
      });
      return;
    }
    this.update((s: HarnessState): void => {
      if (s.jobsPanel !== null) {
        s.jobsPanel.expandedJobId = jobId;
        s.jobsPanel.expandedOutput = null;
        s.jobsPanel.outputLoading = true;
      }
    });
    void this.fetchJobOutput(panel.sessionId, jobId);
  }

  /** 读一条任务的输出（`toggleJobOutput` 的异步后半截）。 */
  private async fetchJobOutput(sessionId: string, jobId: string): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    try {
      const output: JobOutput = await api.jobOutput(sessionId, jobId);
      this.update((s: HarnessState): void => {
        const current: JobsPanelState | null = s.jobsPanel;
        // 用户已收起或换了一条：这次结果作废（否则会「自己弹开」）。
        if (current === null || current.expandedJobId !== jobId) {
          return;
        }
        current.outputLoading = false;
        current.expandedOutput = output;
      });
    } catch (error) {
      const message: string = this.messageOf(error as Object);
      this.update((s: HarnessState): void => {
        const current: JobsPanelState | null = s.jobsPanel;
        if (current === null || current.expandedJobId !== jobId) {
          return;
        }
        // 失败也当成一段「输出」展示：面板里已经展开了这一块，留空会像没反应。
        // lossy 传 false —— 这不是「被留存策略吃掉的字节」，别让界面误报不完整。
        current.outputLoading = false;
        current.expandedOutput = new JobOutput(jobId, message, 0, false, null);
      });
    }
  }
}
