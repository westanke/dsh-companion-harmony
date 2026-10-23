/**
 * 立即按指定配色重设系统导航栏 —— 平台层。
 *
 * 为什么需要它：`EntryAbility.applyNavBarTheme` 只在 onForeground / 系统深浅色切换时
 * 补刷，而且读的是进程内缓存 —— 用户在设置页点配色后，导航条既不立刻变、
 * 切后台再回来还会被旧缓存**改回去**。所以设置页写偏好之后直接调这里，
 * 用刚选中的名字立刻设一次，绕开缓存时序问题。
 *
 * 失败静默：导航条设色失败不影响功能，与 `EntryAbility` 同一口径。
 */

import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { getPalette, ThemePalette } from '../core/ThemePalettes';

/** 立即把系统导航栏设为指定配色的当前深浅阶。 */
export function applyNavBarPalette(context: common.Context, paletteName: string): void {
  try {
    const ability: common.UIAbilityContext = context as common.UIAbilityContext;
    // 枚举值容易记反：COLOR_MODE_DARK = 0（见 EntryAbility 注释 / PORT-MAP 坑 20）。
    const dark: boolean = ability.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    const palette: ThemePalette = getPalette(paletteName, dark);
    const props: window.SystemBarProperties = {
      navigationBarColor: palette.navBarBg,
      navigationBarContentColor: palette.navBarContent,
    };
    window.getLastWindow(context).then((win: window.Window): void => {
      win.setWindowSystemBarProperties(props).catch((): void => {});
    }).catch((): void => {});
  } catch (e) {
    // 拿不到窗口 / 上下文类型不符都不该影响设置动作本身。
  }
}
