/**
 * KeyValueStore 的鸿蒙实现 —— 落在 `@ohos.data.preferences` 上。
 *
 * ## 为什么走同步 API
 *
 * core 的 `HostStore` / `AppPreferences` 都是**同步契约**（`getString` / `putString`
 * 直接返回），这是当初为了「可离线单测」定下的（见 `HostStore.ts` 头注释）。
 * preferences 的异步 API（`getPreferences` / `get` / `put`）没法满足同步签名，
 * 于是这里用 API 10 起提供的同步族：`getPreferencesSync` / `hasSync` / `getSync` /
 * `putSync` / `deleteSync` / `clearSync` / `flushSync`。**已实测 SDK 里存在**。
 *
 * 好处是 core 一行都不用改，427 个单测不受影响。
 *
 * ## 三条不变量
 *
 * 1. **读不抛**：偏好损坏/键缺失一律返回 null（与 `HostStore.loadHosts` 的容错口径一致），
 *    一个设置项读不出来不该让聊天页起不来。
 * 2. **写不抛**：写失败只吞掉，不让调用方崩 —— 偏好是「丢了也不影响可用性」的那一类。
 * 3. **`putString(key, null)` 表示删除**，与 core 的 `KeyValueStore` 契约一致
 *    （不是写空串）。
 */

import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { KeyValueStore } from '../core/HostStore';

export class PrefsStore implements KeyValueStore {
  private prefs: preferences.Preferences;

  constructor(context: common.Context, name: string) {
    this.prefs = preferences.getPreferencesSync(context, { name: name });
  }

  getString(key: string): string | null {
    try {
      if (!this.prefs.hasSync(key)) {
        return null;
      }
      const value: preferences.ValueType = this.prefs.getSync(key, '');
      if (typeof value === 'string') {
        return value as string;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  putString(key: string, value: string | null): void {
    try {
      if (value === null) {
        this.prefs.deleteSync(key);
      } else {
        this.prefs.putSync(key, value);
      }
      this.prefs.flushSync();
    } catch (e) {
      // 忽略：偏好写失败不得影响主流程。
    }
  }

  remove(key: string): void {
    try {
      this.prefs.deleteSync(key);
      this.prefs.flushSync();
    } catch (e) {
      // 忽略。
    }
  }

  clear(): void {
    try {
      this.prefs.clearSync();
      this.prefs.flushSync();
    } catch (e) {
      // 忽略。
    }
  }
}
