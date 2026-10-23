import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { pauseHarnessEvents, resumeHarnessEvents } from '../ui/AppRuntime';
import { getPalette, normalizePaletteName, ThemePalette } from '../core/ThemePalettes';
import { preferences } from '@kit.ArkData';

const DOMAIN: number = 0x0000;
const TAG: string = 'DSH';

const PREFS_NAME: string = 'dsh_settings';
const KEY_PALETTE: string = 'theme_palette';

export default class EntryAbility extends UIAbility {
  /**
   * 主窗口引用。`onConfigurationUpdate`（系统深浅色切换）时要拿它重设导航条颜色，
   * 所以不能在 `onWindowStageCreate` 里用完就丢。
   */
  private mainWindow: window.Window | null = null;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onCreate');
    this.bindColorMode();
  }

  /**
   * 让应用深浅色**跟随系统**（`COLOR_MODE_NOT_SET` = 不锁定、跟系统走）。
   *
   * 显式声明一次，避免应用停在启动那一刻的 colorMode 上：用户在系统设置里切深色时本应用
   * 正在后台，`onConfigurationUpdate` 在后台不回调、回前台也不补发，于是整屏仍是白底 ——
   * 真机现象就是用户说的「开启深色模式了，未关联成功」（见 PORT-MAP 坑 20）。
   */
  private bindColorMode(): void {
    try {
      this.context.getApplicationContext()
        .setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'setColorMode failed: %{public}s', JSON.stringify(err));
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onWindowStageCreate');
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent succeeded');
    });
    // 放在 loadContent 之外：那条回调只在首次加载时跑一次，而窗口引用要一直留着
    // 给 `onConfigurationUpdate` 用。
    this.bindMainWindow(windowStage);
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onWindowStageDestroy');
    this.mainWindow = null;
  }

  /** 取主窗口引用，并立即按当前主题设一次导航条颜色。 */
  private bindMainWindow(windowStage: window.WindowStage): void {
    try {
      this.mainWindow = windowStage.getMainWindowSync();
    } catch (e) {
      // 拿不到主窗口只影响导航条配色，不该连累应用启动 —— 记日志后放行。
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'getMainWindowSync failed: %{public}s', JSON.stringify(err));
      return;
    }
    this.applyNavBarTheme();
  }

  /**
   * 按当前主题设导航条配色。
   *
   * 配色主题（paper/warm/mist/ink）从 Preferences 读 —— 设置页切换时写同一份存储，
   * 这里只负责读。深浅阶由系统 colorMode 决定（应用跟系统走）。
   *
   * **每次都重读 Preferences，不做进程内缓存**：设置页切换配色时虽然会走
   * `platform/NavBar.applyNavBarPalette` 立刻设一次，但随后任何一次 onForeground /
   * onConfigurationUpdate 都会再调本方法 —— 若此处用了启动时缓存的旧值，
   * 会把用户刚选的配色**改回去**（真机实测的退化路径）。
   */
  private applyNavBarTheme(): void {
    const win: window.Window | null = this.mainWindow;
    if (win === null) {
      return;
    }
    const dark: boolean = this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    // 取证日志：把实际生效的 colorMode 打出来。
    // **枚举值容易记反**：`COLOR_MODE_DARK = 0`、`COLOR_MODE_LIGHT = 1`、
    // `COLOR_MODE_NOT_SET = -1` —— 所以「colorMode=0」是**深色**，
    // 别按「0 就是没设置 / 浅色」的直觉去读（见 PORT-MAP 坑 20）。
    hilog.info(DOMAIN, TAG, 'navBar dark=%{public}s colorMode=%{public}d',
      `${dark}`, this.context.config.colorMode);
    preferences.getPreferences(this.context, PREFS_NAME).then((prefs: preferences.Preferences): void => {
      const raw: string = prefs.getSync(KEY_PALETTE, '') as string;
      const paletteName: string = normalizePaletteName(raw.length > 0 ? raw : null);
      const palette: ThemePalette = getPalette(paletteName, dark);
      const props: window.SystemBarProperties = {
        navigationBarColor: palette.navBarBg,
        navigationBarContentColor: palette.navBarContent,
      };
      win.setWindowSystemBarProperties(props).catch((err: BusinessError): void => {
        hilog.warn(DOMAIN, TAG, 'setWindowSystemBarProperties failed: %{public}s', JSON.stringify(err));
      });
    }).catch((err: BusinessError): void => {
      // Preferences 读失败回落默认 PAPER（normalizePaletteName(null)）。
      hilog.warn(DOMAIN, TAG, 'navBar prefs failed: %{public}s', JSON.stringify(err));
      const palette: ThemePalette = getPalette(normalizePaletteName(null), dark);
      win.setWindowSystemBarProperties({
        navigationBarColor: palette.navBarBg,
        navigationBarContentColor: palette.navBarContent,
      }).catch((): void => {});
    });
  }

  /**
   * 系统深浅色切换。
   *
   * 必须在这里重设一次：`setWindowSystemBarProperties` 一旦调用过，这条导航条就不再
   * 由系统自动跟随主题，不重设的话切到深色后它会停在浅色上 —— 正是本轮要修的那个现象。
   */
  onConfigurationUpdate(newConfig: Configuration): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onConfigurationUpdate colorMode=%{public}d', newConfig.colorMode);
    this.applyNavBarTheme();
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onForeground');
    // 回到前台：接回事件流，并补上熄屏期间错过的会话历史与交互性状态（审批 / 待答问题）。
    resumeHarnessEvents();
    // 回前台补一次导航条配色：系统深浅色很可能是在本应用**处于后台**时被切换的
    // （用户去系统设置里点开关），而那种时序下 `onConfigurationUpdate` 不保证回调
    // —— 不补这一次，导航条会停在旧色上（见 bindColorMode 注释）。
    this.applyNavBarTheme();
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onBackground');
    // 退到后台**只关事件流**，连接与已加载数据都保留 —— 回来时是即时的，不必重新连接。
    pauseHarnessEvents();
  }
}
