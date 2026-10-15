/**
 * 用系统能力打开一个外部链接 —— 平台层。
 *
 * 源工程对应 Android 的 `Intent(ACTION_VIEW, uri)`；鸿蒙这边对应
 * `startAbility` 带 `ohos.want.action.viewData` + `entity.system.browsable`。
 *
 * 为什么单独一个文件而不是塞进 `Clipboard.ets`：它与剪贴板没有关系，
 * 只被聊天页的链接分流用到（`ChatLinkTarget` 判定为 WEB 的那些）。
 *
 * 失败不抛错，只返回 false —— 没有浏览器、或系统不允许隐式拉起，
 * 都是**用户能理解的结果**（界面给一句「没有能打开这个链接的应用」即可），
 * 让它以异常形式冒到 UI 层只会变成一次崩溃。
 */

import { common, Want } from '@kit.AbilityKit';

/** 打开成功返回 true；失败（无应用可处理、被系统拒绝）返回 false。 */
export function openExternalUrl(context: common.Context, url: string): boolean {
  try {
    const want: Want = {
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: url,
    };
    const ability: common.UIAbilityContext = context as common.UIAbilityContext;
    ability.startAbility(want).catch((e: Object): void => {
      // 隐式拉起失败是异步报出来的（没有匹配的应用），这里吞掉：
      // 界面已经在调用点按返回值给提示了。
    });
    return true;
  } catch (e) {
    return false;
  }
}
