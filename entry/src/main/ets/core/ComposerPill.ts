/**
 * 输入框占位符该显示哪一段 —— 移植自原工程 `ui/ChatScreen.kt` 的
 * `ComposerHint` / `composerHint`（对应上游的 `ComposerPillTest`）。
 *
 * 原来是「运行中回车会排队还是插话」在输入框**下方**单独占一行文字；照网页版把它压进
 * 占位符之后，那一行就没了 —— 占位符成了唯一说明。所以这里必须钉死：
 * **选错资源在屏幕上只是一行小字**，肉眼点界面根本覆盖不到。
 */

export enum ComposerHint {
  IDLE = 'IDLE',
  RUNNING_QUEUE = 'RUNNING_QUEUE',
  RUNNING_STEER = 'RUNNING_STEER',
}

/**
 * 空闲时不谈排队/插话（没有可插话的轮次），设置里的「繁忙时默认行为」也不该影响占位符。
 */
export function composerHint(sessionRunning: boolean, steerIsDefault: boolean): ComposerHint {
  if (!sessionRunning) {
    return ComposerHint.IDLE;
  }
  return steerIsDefault ? ComposerHint.RUNNING_STEER : ComposerHint.RUNNING_QUEUE;
}
