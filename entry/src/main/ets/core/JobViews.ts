/**
 * 后台任务（bridge ≥ 2.4.3 的 `GET/POST /chat/sessions/{sessionId}/jobs/...`）
 * —— 移植自源工程 `data/JobViews.kt`。
 *
 * 数据源与形状依据见姊妹仓 `dsh-remote-bridge`：服务端已逐字段校验过内核
 * `JobView` 的类型（缺 id/kind/label 或未知 status 会在服务端就转成 502
 * `JOB_SHAPE_INVALID`，不会透过来），所以这里的字段按「服务端保证过」的口径写。
 *
 * 三条 wire 约定客户端必须知道：
 * - `owner` / `progress` / `detail` / `finishedAt` 是**可选字段**：内核没给就是没有
 *   （无主任务没有 owner、存活中没有 finishedAt），客户端不该看到 `owner: undefined`；
 * - `JobOutput.next` 是**绝对字节偏移**，增量续读时把它当 `from` 再调即可；
 * - `JobOutput.lossy = true` 表示「请求偏移与返回内容之间有字节被留存策略吃掉」，
 *   这段输出**不是完整的**，必须提示用户，不能当成全部展示。
 *
 * 虽然服务端保证过形状，本文件仍按 `Models.ts` 的三条规矩（缺键 / 显式 null /
 * 类型不符 → 退化为默认值、绝不抛异常）解析：**服务端保证的是它自己的那一份**，
 * 而这里是第二道防线 —— 一个 502 已经在服务端发生了，客户端不该因为一处形状意外
 * 就把整块面板打崩。
 */

import { JsonAccess, JsonMap } from './JsonAccess';

/** 存活中（可能还在产出）。 */
export const JOB_STATUS_RUNNING: string = 'running';
export const JOB_STATUS_STOPPING: string = 'stopping';
export const JOB_STATUS_COMPLETED: string = 'completed';
export const JOB_STATUS_KILLED: string = 'killed';
export const JOB_STATUS_FAILED: string = 'failed';

/**
 * 是否处于存活中（可能还在产出）。终态任务不能也不必终止。
 *
 * 刻意**用白名单**而不是「不属于终态就是存活」：将来内核多出一种状态
 * （比如 `suspended`），黑名单写法会把它误判成存活、于是一个不可终止的任务
 * 上挂着「终止」按钮 —— 白名单写法只会让它不显示按钮，方向是安全的。
 */
export function isJobLive(status: string): boolean {
  return status === JOB_STATUS_RUNNING || status === JOB_STATUS_STOPPING;
}

/** 一个后台任务的对外视图（内核 `JobView` 的结构投影）。 */
export class JobView {
  id: string = '';
  kind: string = '';
  /** 生产者给的一行说明（命令行、阶段名……），列表里主要就看它。 */
  label: string = '';
  /** 属主会话；无主任务没有这个字段（任何会话都可见）。 */
  owner: string | null = null;
  /** 生命周期状态；服务端已保证是那五个之一，这里仍是普通字符串。 */
  status: string = '';
  /** 实时进度行（`3/10`、当前阶段）；终态时被清空。 */
  progress: string | null = null;
  /** 终态原因（`exit code: 3`）；人工取消的原因会并进来。 */
  detail: string | null = null;
  /** 注册时刻（epoch ms）。 */
  startedAt: number = 0;
  /** 落定时刻（epoch ms）；存活中为 null。 */
  finishedAt: number | null = null;

  constructor(id: string = '', kind: string = '', label: string = '', owner: string | null = null,
              status: string = '', progress: string | null = null, detail: string | null = null,
              startedAt: number = 0, finishedAt: number | null = null) {
    this.id = id;
    this.kind = kind;
    this.label = label;
    this.owner = owner;
    this.status = status;
    this.progress = progress;
    this.detail = detail;
    this.startedAt = startedAt;
    this.finishedAt = finishedAt;
  }

  /** 该任务是否存活中（见 [isJobLive]）。 */
  isLive(): boolean {
    return isJobLive(this.status);
  }

  static fromJson(map: JsonMap | null): JobView {
    const v: JobView = new JobView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.kind = JsonAccess.str(map, 'kind') ?? '';
    v.label = JsonAccess.str(map, 'label') ?? '';
    v.owner = JsonAccess.str(map, 'owner');
    v.status = JsonAccess.str(map, 'status') ?? '';
    v.progress = JsonAccess.str(map, 'progress');
    v.detail = JsonAccess.str(map, 'detail');
    v.startedAt = JsonAccess.num(map, 'startedAt') ?? 0;
    v.finishedAt = JsonAccess.num(map, 'finishedAt');
    return v;
  }
}

/** 一个后台任务已保留的输出。 */
export class JobOutput {
  jobId: string = '';
  text: string = '';
  /** 绝对字节偏移；下次增量续读传它。 */
  next: number = 0;
  /** true = 这段输出前面有字节被留存策略吃掉了，不是从头开始的完整输出。 */
  lossy: boolean = false;
  /** 读到终态帧时带上；流被提前切断时为 null。 */
  status: string | null = null;

  constructor(jobId: string = '', text: string = '', next: number = 0, lossy: boolean = false,
              status: string | null = null) {
    this.jobId = jobId;
    this.text = text;
    this.next = next;
    this.lossy = lossy;
    this.status = status;
  }

  static fromJson(map: JsonMap | null): JobOutput {
    const v: JobOutput = new JobOutput();
    v.jobId = JsonAccess.str(map, 'jobId') ?? '';
    v.text = JsonAccess.str(map, 'text') ?? '';
    v.next = JsonAccess.num(map, 'next') ?? 0;
    v.lossy = JsonAccess.bool(map, 'lossy') ?? false;
    v.status = JsonAccess.str(map, 'status');
    return v;
  }
}

/** 终止结果。 */
export class JobKillResult {
  jobId: string = '';
  /**
   * `requested` = 已受理；`already-finished` = 已是终态、无需再杀。
   * 界面应据此显示「已结束」而不是「已终止」——两者不是一回事。
   */
  outcome: string = '';

  constructor(jobId: string = '', outcome: string = '') {
    this.jobId = jobId;
    this.outcome = outcome;
  }

  static fromJson(map: JsonMap | null): JobKillResult {
    const v: JobKillResult = new JobKillResult();
    v.jobId = JsonAccess.str(map, 'jobId') ?? '';
    v.outcome = JsonAccess.str(map, 'outcome') ?? '';
    return v;
  }
}

/** 终止请求是否**被受理**（`requested`）；`already-finished` 时返回 false。 */
export function killWasRequested(outcome: string): boolean {
  return outcome !== 'already-finished';
}

/**
 * 「跑了多久」的展示文案：`3 min 12 s` / `1 h 5 min` / `45 s`。
 *
 * 远程场景里「还要等多久」比「开始于几点几分」有用，所以列表上放这个而不是绝对时刻。
 *
 * 两处刻意为之：
 * - **`nowMs` 由调用方传进来**，这里不读时钟 —— 纯函数才能被单测钉住边界值。
 * - 单位文案（`h` / `min` / `s`）**不本地化**，与源工程一字不差：源工程同样是拼字面量，
 *   且这三种缩写在中英文界面里都是可读的。
 *
 * 存活中的任务用「当前时刻」算，所以界面每次重绘都会自己往前走；终态任务用
 * `finishedAt` 算，是固定的总时长。
 */
export function jobDurationText(job: JobView, nowMs: number): string {
  const end: number = job.finishedAt === null ? nowMs : job.finishedAt;
  let seconds: number = Math.floor((end - job.startedAt) / 1000);
  if (seconds < 0) {
    // 时钟回拨或服务端时间戳对不上时别显示负数。
    seconds = 0;
  }
  const minutes: number = Math.floor(seconds / 60);
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }
  if (minutes >= 1) {
    return `${minutes} min ${seconds % 60} s`;
  }
  return `${seconds} s`;
}
