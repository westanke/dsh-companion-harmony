/**
 * 剪贴板 —— `@ohos.pasteboard`。
 *
 * 连接页的「从电脑导入配置」需要它：用户手上是一段 `DSH1:` 开头的长文本，
 * 手动敲不现实。也是聊天页「复制全文」「复制工具输出」的基础能力。
 *
 * ## 读为什么读不到、写为什么不需要权限
 *
 * 读剪贴板要 `ohos.permission.READ_PASTEBOARD`，而它在鸿蒙里是**受限权限**
 * （system_basic 级，要 ACL 加白）。普通应用把它写进 `module.json5` 的
 * `requestPermissions`，**包都装不上** —— 实测：
 *   9568329 install failed due to grant request permissions failed.
 *   PermissionName: ohos.permission.READ_PASTEBOARD
 * 所以本工程不申请它，`getDataSync()` 必然抛错，也就是说
 * **「一键读剪贴板」对普通应用这条路不存在**。
 *
 * 于是读取降级为「提示用户长按输入框用系统粘贴」——系统粘贴是系统代办的，
 * 不经过应用权限；写（复制）本来就不需要权限，照常可用。
 *
 * 走同步族（`getDataSync`/`setDataSync`）：调用点都在点击回调里，结果要立刻反映到界面。
 */

import { pasteboard } from '@kit.BasicServicesKit';
import { normalizePrimaryText } from '../core/ClipboardText';

/**
 * 读剪贴板文本。
 *
 * 返回空串 = 「没拿到可用文本」，涵盖三种情况：系统不允许读（本工程必然如此）、
 * 剪贴板空、剪贴板里不是文本。**这三者对调用方等价**（都只能让用户改用手动粘贴），
 * 所以这里不区分 —— 但调用方拿到空串时**必须给出提示**，
 * 静默什么都不做会让人以为按钮坏了。
 *
 * ⚠️ **返回值一定是字符串**，这不是多余的话，是有过一次闪退教训的：
 * `getPrimaryText()` 声明 `string`、运行时却会给 `undefined`，而调用方写的是
 * `const text = readClipboardText(); if (text.length > 0)` —— 一个 `undefined`
 * 换来的是整进程被杀（2026-10-20 AGC 驳回，详见 `core/ClipboardText.ts` 的文件头）。
 * 归一这件事交给那个纯函数，好在 `node --test` 里钉住。
 */
export function readClipboardText(): string {
  try {
    const board: pasteboard.SystemPasteboard = pasteboard.getSystemPasteboard();
    if (!board.hasDataSync()) {
      return '';
    }
    const data: pasteboard.PasteData = board.getDataSync();
    return normalizePrimaryText(data.getPrimaryText());
  } catch (e) {
    // 无 READ_PASTEBOARD 权限时走到这里（BusinessError 201）。见文件头。
    return '';
  }
}

/** 写文本进剪贴板；不需要权限，失败静默（复制不上不该打断用户正在做的事）。 */
export function writeClipboardText(text: string): void {
  try {
    const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
    pasteboard.getSystemPasteboard().setDataSync(data);
  } catch (e) {
    // 忽略。
  }
}
