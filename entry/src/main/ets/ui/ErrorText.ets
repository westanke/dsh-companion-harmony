/**
 * 错误码 → 人话（源工程 `localError`）。
 *
 * ## 为什么独立成一个文件
 *
 * 这段映射原本只写在 `AppShell` 里。但 `AppShell` **只在连上之后才挂载** ——
 * 连接页上有失败（例如网络不通）时它根本不存在，于是 `state.error` 没人报，
 * 界面上一片安静：标题、按钮、配对按钮**仍然都写着「连接」**，用户看不出
 * 刚才那次尝试已经失败了。
 *
 * 源工程 `App.kt` 的写法是**在顶层**把 `state.error` 交给 Snackbar，而
 * `SnackbarHost` 在连接页与主界面**两处都挂**。移植时只保留了主界面那一处，
 * 所以这条映射要能被两边共用 —— 放在这里而不是复制两份。
 */

import { common } from '@kit.AbilityKit';

export function localErrorText(ctx: common.Context, value: string): string {
  const rm = ctx.resourceManager;
  if (value === 'FILE_TOO_LARGE') {
    return rm.getStringSync($r('app.string.file_too_large').id);
  }
  if (value === 'BINARY_FILE') {
    return rm.getStringSync($r('app.string.binary_file').id);
  }
  if (value.startsWith('ETAG_MISMATCH') || value.startsWith('HTTP 412')) {
    return rm.getStringSync($r('app.string.etag_conflict').id);
  }
  if (value.startsWith('RATE_LIMITED')) {
    return rm.getStringSync($r('app.string.rate_limited').id);
  }
  if (value.startsWith('AGENT_PRESET_LOCKED') || value.startsWith('DSH_AGENT_PRESET_LOCKED')) {
    return rm.getStringSync($r('app.string.agent_preset_locked').id);
  }
  // 配置文本解析失败必须给一句人能看懂的话：此刻用户人已经到了外面，
  // 屏幕上只有一段粘贴进来的文本，一句 "CONFIG_INVALID" 帮不了他。
  if (value.startsWith('CONFIG_INVALID')) {
    return rm.getStringSync($r('app.string.import_invalid').id);
  }
  return value;
}
