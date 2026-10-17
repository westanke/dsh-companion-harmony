/**
 * 轻量应用偏好 —— 移植自原工程 `data/AppPreferences.kt`。
 *
 * 与 `HostStore` 的分工：那里存的是**凭据与主机**（整体加密，损坏时容错），
 * 这里存的是**纯偏好**（明文即可，丢失只影响一次点击行为，不影响可用性），
 * 所以刻意不共用一套存储，避免把「读偏好失败」卷进凭据的容错路径。
 *
 * 读取一律带兜底：偏好损坏或键缺失时回落到默认值，**绝不抛异常** ——
 * 一个设置项的取值问题不该让聊天界面起不来。
 *
 * ## 与安卓版的两处有意差异
 *
 * 1. 安卓用 `SharedPreferences`，这里走注入的 `KeyValueStore`（鸿蒙侧是
 *    `@ohos.data.preferences`，测试里是内存 Map），于是本模块可以脱离系统单测。
 * 2. 安卓的 `getBoolean/putBoolean` 由系统提供；`KeyValueStore` 只有字符串读写，
 *    所以布尔偏好统一按 `'true'` / `'false'` 字符串落盘（见 [AppPreferences.getBool]）。
 *
 * ## 关于 BusySendMode 的取值
 *
 * 安卓把枚举名（`QUEUE` / `STEER`）写进偏好。这里直接存**线上取值**
 * （`'queue'` / `'steer'`，即 `ComposerSendPolicy` 里的 `SEND_MODE_*`），
 * 与「全链路不做 enum↔字符串来回转换」的既定口径保持一致，少一层出错可能。
 * 该偏好是本 App 新装即默认，无需与安卓旧数据互通，因此不存在迁移问题。
 */

import { KeyValueStore } from './HostStore';
import { SEND_MODE_QUEUE, SEND_MODE_STEER, oppositeSendMode } from './ComposerSendPolicy';
import { FONT_SCALE_DEFAULT, normalizeFontScale } from './FontScale';
import { THEME_MODE_SYSTEM, normalizeThemeMode } from './ThemeMode';

/** 偏好文件名。刻意与凭据库（`dsh_connection`）分开。 */
export const SETTINGS_PREFERENCES_NAME: string = 'dsh_settings';

const KEY_BUSY_SEND_MODE: string = 'busy_send_mode';
const KEY_GEN_UI_DEBUG: string = 'gen_ui_debug';
const KEY_USE_WEB_CHAT: string = 'use_web_chat';
const KEY_SHOW_CONTEXT: string = 'show_context';
const KEY_FONT_SCALE: string = 'font_scale';
const KEY_FONT_FOLLOWS_SYSTEM: string = 'font_follows_system';
const KEY_THEME_MODE: string = 'theme_mode';

export class AppPreferences {
  private store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.store = store;
  }

  /**
   * 智能体运行时，Enter 与主发送按钮的默认行为。
   * 取值只认 `'queue'` / `'steer'`；缺失或认不出（含旧版大写枚举名）一律回落「排队」。
   */
  get busySendMode(): string {
    const raw: string | null = this.store.getString(KEY_BUSY_SEND_MODE);
    if (raw === SEND_MODE_QUEUE || raw === SEND_MODE_STEER) {
      return raw;
    }
    return SEND_MODE_QUEUE;
  }

  set busySendMode(value: string) {
    this.store.putString(KEY_BUSY_SEND_MODE,
      value === SEND_MODE_QUEUE || value === SEND_MODE_STEER ? value : SEND_MODE_QUEUE);
  }

  /** 另一个模式的便捷入口：`Cmd/Ctrl+Enter` 走的就是它。 */
  alternateSendMode(): string {
    return oppositeSendMode(this.busySendMode);
  }

  /**
   * dsh-ui 诊断开关：**默认关**。
   *
   * 打开后每条助手消息下方显示一行灰字，逐项报告围栏识别 / JSON 解析 / 节点分发的结果。
   * 存在的理由很直接：这条链路上没有实机可验证，而「没渲染」和「渲染了但空白」
   * 在屏幕上长得一模一样，靠猜改代码等于掷骰子。有了这行字，用户截图发回来就是完整现场。
   */
  get genUiDebug(): boolean {
    return this.getBool(KEY_GEN_UI_DEBUG, false);
  }

  set genUiDebug(value: boolean) {
    this.putBool(KEY_GEN_UI_DEBUG, value);
  }

  /**
   * 会话详情页走 WebView 版还是原生版。
   *
   * 默认 false。鸿蒙侧的聊天页按既定方案是 **ArkUI 原生重写**（不走 WebView），
   * 该偏好保留是为了「给英文/浏览器方案留好接口」：日后若要并行挂一份 Web 渲染，
   * 设置项已经在这里，不必改数据结构。
   */
  get useWebChat(): boolean {
    return this.getBool(KEY_USE_WEB_CHAT, false);
  }

  set useWebChat(value: boolean) {
    this.putBool(KEY_USE_WEB_CHAT, value);
  }

  /**
   * 聊天页里是否显示「上下文注入」块（运行上下文 / 时间上下文 / 后台任务通知…）。
   *
   * 默认 **false**：那些是系统每轮塞进来的东西，手机端没人看，
   * 却会在每条消息之间插一排折叠块，把正文挤得七零八落。需要排查时再打开。
   */
  get showContext(): boolean {
    return this.getBool(KEY_SHOW_CONTEXT, false);
  }

  set showContext(value: boolean) {
    this.putBool(KEY_SHOW_CONTEXT, value);
  }

  /**
   * 应用内字号倍数（0.8–1.5，步进 0.1）。
   *
   * 与源工程同一取向：**这一层是与「跟随系统」互斥的乘数**，勾了跟随系统时它只是个
   * 被记住的落点值（见 `FontScale.effectiveFontScale`）。
   *
   * 读取一律过 `normalizeFontScale`：坏值（NaN / 越界 / 非数字）回落到 1.0 ——
   * 一个坏偏好绝不能变成「整个界面用 NaN 尺寸测量」（白屏且不崩，最难查的一种）。
   */
  get fontScale(): number {
    const raw: string | null = this.store.getString(KEY_FONT_SCALE);
    if (raw === null) {
      return FONT_SCALE_DEFAULT;
    }
    return normalizeFontScale(Number.parseFloat(raw));
  }

  set fontScale(value: number) {
    this.store.putString(KEY_FONT_SCALE, `${normalizeFontScale(value)}`);
  }

  /**
   * 字号是否跟随系统。默认 **true**。
   *
   * 默认跟随而不是默认 1.0：一个刚装上的应用**不该**擅自把用户调大的系统字号缩回去 ——
   * 那是用户在系统设置里明确要的效果，应用这层的默认立场就该是「不插嘴」。
   */
  get fontFollowsSystem(): boolean {
    return this.getBool(KEY_FONT_FOLLOWS_SYSTEM, true);
  }

  set fontFollowsSystem(value: boolean) {
    this.putBool(KEY_FONT_FOLLOWS_SYSTEM, value);
  }

  /** 主题档位（`system` / `light` / `dark`），默认跟随系统。 */
  get themeMode(): string {
    return normalizeThemeMode(this.store.getString(KEY_THEME_MODE));
  }

  set themeMode(value: string) {
    this.store.putString(KEY_THEME_MODE, normalizeThemeMode(value));
  }

  /** 布尔读取：键缺失用 `fallback`，其余只认字面量 `'true'`。 */
  private getBool(key: string, fallback: boolean): boolean {
    const raw: string | null = this.store.getString(key);
    if (raw === null) {
      return fallback;
    }
    return raw === 'true';
  }

  private putBool(key: string, value: boolean): void {
    this.store.putString(key, value ? 'true' : 'false');
  }
}
