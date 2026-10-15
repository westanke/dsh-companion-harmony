import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { pauseHarnessEvents, resumeHarnessEvents } from '../ui/AppRuntime';

const DOMAIN: number = 0x0000;
const TAG: string = 'DSH';

/**
 * 系统导航条（底部那条手势条）的配色，**跟随系统深浅色**。
 *
 * 为什么要在应用里显式设：不设的时候这条由系统按它自己的规则着色 —— 实测浅色页面下
 * 它在深色系统主题里依然是白的，于是"一条白条浮在内容之上"（用户原话）。这里让它跟
 * 应用当前生效的主题走（应用主题随系统，见 PORT-MAP「主题随系统」条目）。
 *
 * 取值与页面背景 `sys.color.ohos_id_color_background` 一致，内容色取其对比色：
 * 浅色 = 白底黑图标，深色 = 黑底白图标。
 *
 * 只设导航条、**不动状态栏**：状态栏现在没有不匹配问题（应用内容未延伸到状态栏区域，
 * dump 里 WindowScene 的 bounds 自 y=122 起），顺手改它只会引入新的避让风险。
 */
const NAV_BAR_COLOR_LIGHT: string = '#FFFFFFFF';
const NAV_BAR_COLOR_DARK: string = '#FF000000';
const NAV_BAR_CONTENT_LIGHT: string = '#FF000000';
const NAV_BAR_CONTENT_DARK: string = '#FFFFFFFF';

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
   * `colorMode` 还有第三种取值 `COLOR_MODE_NOT_SET`（系统未指定偏好）—— 这时按浅色
   * 兜底：系统未给偏好时按浅色渲染本来就是鸿蒙的默认行为，与页面背景的默认取值一致。
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
    const props: window.SystemBarProperties = {
      navigationBarColor: dark ? NAV_BAR_COLOR_DARK : NAV_BAR_COLOR_LIGHT,
      navigationBarContentColor: dark ? NAV_BAR_CONTENT_DARK : NAV_BAR_CONTENT_LIGHT,
    };
    win.setWindowSystemBarProperties(props).catch((err: BusinessError): void => {
      hilog.warn(DOMAIN, TAG, 'setWindowSystemBarProperties failed: %{public}s', JSON.stringify(err));
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
