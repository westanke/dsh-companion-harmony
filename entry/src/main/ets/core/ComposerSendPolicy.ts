/**
 * 「按下发送之后走哪条路」的纯逻辑 —— 移植自原工程 `data/ComposerSendPolicy.kt`。
 *
 * DSH 的 `prompt` 只认两种 `mode`：
 * - `queue` —— 排队，等当前这一轮结束后再处理；
 * - `steer` —— 插话，作为追加引导送进**正在运行**的那一轮。
 *
 * 为什么从输入框组件里抽出来：这段判断有几个容易搞错的组合（空闲、繁忙+默认、繁忙+反向、
 * 没有正在运行的会话），而它们值得被单测钉死 —— 埋在几千行的界面文件里就只能靠手点验证了。
 *
 * 这里用字符串常量而不是 enum：`mode` 一路传到 `ChatContentParts.messageBody` 的请求体里，
 * 全链路都是**线上取值**（`'queue'` / `'steer'`），中间不做一次 enum↔字符串的来回转换，
 * 少一层出错可能。
 */

import { isNotBlank } from './TextPredicates';

/** 运行中提交 = 排队（等这一轮结束后处理）。 */
export const SEND_MODE_QUEUE: string = 'queue';

/** 运行中提交 = 插话（追加引导送进正在运行的那一轮）。 */
export const SEND_MODE_STEER: string = 'steer';

/** 另一个模式。Cmd/Ctrl+Enter 走的就是它。 */
export function oppositeSendMode(mode: string): string {
  return mode === SEND_MODE_QUEUE ? SEND_MODE_STEER : SEND_MODE_QUEUE;
}

/**
 * 决定这次提交用哪个 mode。
 *
 * @param busy 当前会话是否正在运行（决定有没有「插话」这个选项）
 * @param preferred 用户设置的「繁忙时默认行为」
 * @param alternate 用户是否按下了备用组合键（Cmd/Ctrl+Enter）
 *
 * 空闲时没有可插话的轮次，`steer` 没有意义，一律按排队提交 —— 即使 `preferred` 是 `steer`，
 * 即使按了备用组合键，也照样回落 `queue`（此时 queue 等价于普通发送）。
 */
export function resolveSendMode(busy: boolean, preferred: string, alternate: boolean = false): string {
  if (!busy) {
    return SEND_MODE_QUEUE;
  }
  return alternate ? oppositeSendMode(preferred) : preferred;
}

/** 是否可以提交：内容非空（不是「全是空白」）、且有写权限。 */
export function canSubmit(text: string, canWrite: boolean): boolean {
  return isNotBlank(text) && canWrite;
}
