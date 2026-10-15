import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppPreferences, SETTINGS_PREFERENCES_NAME } from '../../entry/src/main/ets/core/AppPreferences.ts';
import { SEND_MODE_QUEUE, SEND_MODE_STEER } from '../../entry/src/main/ets/core/ComposerSendPolicy.ts';
import { KeyValueStore } from '../../entry/src/main/ets/core/HostStore.ts';

/**
 * 应用偏好的测试。重点在两件事：
 * 1. **兜底**：键缺失/值损坏/值认不出时一律回落默认值，绝不抛异常（界面不能因一个设置项起不来）。
 * 2. **落盘形状**：布尔按 `'true'`/`'false'` 字符串存；发送模式只认线上取值。
 */

class MemoryStore implements KeyValueStore {
  readonly map: Map<string, string> = new Map();

  getString(key: string): string | null {
    return this.map.has(key) ? this.map.get(key) as string : null;
  }

  putString(key: string, value: string | null): void {
    if (value === null) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

test('偏好文件名与凭据库分开（避免把「读偏好失败」卷进凭据容错路径）', () => {
  assert.equal(SETTINGS_PREFERENCES_NAME, 'dsh_settings');
});

test('默认值：繁忙发送=排队，其余三个开关全关', () => {
  const prefs = new AppPreferences(new MemoryStore());
  assert.equal(prefs.busySendMode, SEND_MODE_QUEUE);
  assert.equal(prefs.genUiDebug, false);
  assert.equal(prefs.useWebChat, false);
  assert.equal(prefs.showContext, false);
});

test('繁忙发送模式：读写往返', () => {
  const prefs = new AppPreferences(new MemoryStore());
  prefs.busySendMode = SEND_MODE_STEER;
  assert.equal(prefs.busySendMode, SEND_MODE_STEER);
  prefs.busySendMode = SEND_MODE_QUEUE;
  assert.equal(prefs.busySendMode, SEND_MODE_QUEUE);
});

test('繁忙发送模式：认不出的值（含安卓旧版的大写枚举名）回落「排队」', () => {
  const store = new MemoryStore();
  store.putString('busy_send_mode', 'STEER');
  const prefs = new AppPreferences(store);
  assert.equal(prefs.busySendMode, SEND_MODE_QUEUE);

  store.putString('busy_send_mode', 'garbage');
  assert.equal(prefs.busySendMode, SEND_MODE_QUEUE);
});

test('繁忙发送模式：写入非法值时按「排队」落盘，不留垃圾在偏好里', () => {
  const store = new MemoryStore();
  const prefs = new AppPreferences(store);
  prefs.busySendMode = 'nonsense';
  assert.equal(store.getString('busy_send_mode'), SEND_MODE_QUEUE);
  assert.equal(prefs.busySendMode, SEND_MODE_QUEUE);
});

test('alternateSendMode：取与默认相反的那个模式', () => {
  const prefs = new AppPreferences(new MemoryStore());
  assert.equal(prefs.alternateSendMode(), SEND_MODE_STEER);
  prefs.busySendMode = SEND_MODE_STEER;
  assert.equal(prefs.alternateSendMode(), SEND_MODE_QUEUE);
});

test('布尔偏好：按 `true`/`false` 字符串落盘', () => {
  const store = new MemoryStore();
  const prefs = new AppPreferences(store);

  prefs.genUiDebug = true;
  assert.equal(store.getString('gen_ui_debug'), 'true');
  prefs.genUiDebug = false;
  assert.equal(store.getString('gen_ui_debug'), 'false');

  prefs.useWebChat = true;
  assert.equal(store.getString('use_web_chat'), 'true');
  prefs.showContext = true;
  assert.equal(store.getString('show_context'), 'true');
});

test('布尔偏好：读回自己写下的值', () => {
  const prefs = new AppPreferences(new MemoryStore());
  prefs.genUiDebug = true;
  prefs.useWebChat = true;
  prefs.showContext = true;
  assert.equal(prefs.genUiDebug, true);
  assert.equal(prefs.useWebChat, true);
  assert.equal(prefs.showContext, true);
});

test('布尔偏好：损坏值（非 true 字面量）按 false 处理，不抛异常', () => {
  const store = new MemoryStore();
  store.putString('gen_ui_debug', 'yes');
  store.putString('use_web_chat', '');
  const prefs = new AppPreferences(store);
  assert.equal(prefs.genUiDebug, false);
  assert.equal(prefs.useWebChat, false);
});

test('布尔偏好：显式写入 false 后，键缺失与键存在为 false 等价', () => {
  const store = new MemoryStore();
  const prefs = new AppPreferences(store);
  prefs.genUiDebug = true;
  assert.equal(prefs.genUiDebug, true);
  store.remove('gen_ui_debug');
  assert.equal(prefs.genUiDebug, false);
});

test('偏好独立命名空间：不同 store 实例互不串味', () => {
  const a = new AppPreferences(new MemoryStore());
  const b = new AppPreferences(new MemoryStore());
  a.genUiDebug = true;
  assert.equal(a.genUiDebug, true);
  assert.equal(b.genUiDebug, false);
});
