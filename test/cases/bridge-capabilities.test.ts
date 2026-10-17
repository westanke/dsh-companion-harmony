import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonMap } from '../../entry/src/main/ets/core/JsonAccess.ts';
import {
  ARCHIVE_LIST_CAPABILITY, BridgeCapabilities, REQUIRED_CAPABILITIES,
  missingRequiredCapabilities, parseBridgeCapabilities, supportsArchiveListing,
} from '../../entry/src/main/ets/core/BridgeCapabilities.ts';

/**
 * 服务端能力位解析的测试 —— 逐条对应原工程 `BridgeCapabilitiesTest.kt`。
 *
 * 为什么值得测：这两条判据错的方向都是**假结论** ——
 * 把「未知」当成「什么都缺」会弹出假警告（用户很快就学会忽略警告）；
 * 把「不支持归档」当成支持会展示出「一条归档都没有」（用户会以为数据丢了）。
 */

function ready(capabilities: Object, bridgeVersion: Object = '2.0.4'): JsonMap {
  return { bridgeVersion: bridgeVersion, capabilities: capabilities };
}

// ── parseBridgeCapabilities：读得到 / 读不到 ──

test('读到版本与清单', () => {
  const parsed: BridgeCapabilities | null =
    parseBridgeCapabilities(ready(['approvals-v1', 'questions-v1', 'session-archive-list-v1']));
  assert.notEqual(parsed, null);
  assert.equal((parsed as BridgeCapabilities).bridgeVersion, '2.0.4');
  assert.equal((parsed as BridgeCapabilities).capabilities.size, 3);
});

test('data 为 null → null（未知）', () => {
  assert.equal(parseBridgeCapabilities(null), null);
});

test('缺 capabilities 字段 → null（旧服务端根本不报）', () => {
  assert.equal(parseBridgeCapabilities({ bridgeVersion: '1.0.0' }), null);
});

test('空清单 → null 而不是空集合：真实的空数组只可能是字段被误删，当成「什么都缺」会弹假警告', () => {
  assert.equal(parseBridgeCapabilities(ready([])), null);
});

test('清单里的非字符串项被剔除，只留字符串', () => {
  const parsed: BridgeCapabilities | null =
    parseBridgeCapabilities(ready(['approvals-v1', 42, true, 'questions-v1', null]));
  assert.notEqual(parsed, null);
  const caps: Set<string> = (parsed as BridgeCapabilities).capabilities;
  assert.equal(caps.size, 2);
  assert.equal(caps.has('approvals-v1'), true);
  assert.equal(caps.has('questions-v1'), true);
  // 数字若被读成 `"42"`，清单里就会多一条永远匹配不上的假能力位。
  assert.equal(caps.has('42'), false);
});

test('全是非字符串 → 与空清单同待遇（null）', () => {
  assert.equal(parseBridgeCapabilities(ready([1, 2])), null);
});

test('缺 bridgeVersion 不算致命：版本只是诊断用的，不影响能力判据', () => {
  const parsed: BridgeCapabilities | null = parseBridgeCapabilities({ capabilities: ['approvals-v1'] });
  assert.notEqual(parsed, null);
  assert.equal((parsed as BridgeCapabilities).bridgeVersion, null);
});

test('capabilities 不是数组 → null（不把对象当清单读）', () => {
  assert.equal(parseBridgeCapabilities(ready({ approvals: true })), null);
});

// ── supportsArchiveListing：能力位未知一律不显示入口 ──

test('声明了 session-archive-list-v1 → 支持', () => {
  assert.equal(supportsArchiveListing(new Set<string>([ARCHIVE_LIST_CAPABILITY])), true);
});

test('能力位未知（null）→ 不支持：老 bridge 会忽略 archived 参数返回未归档列表', () => {
  assert.equal(supportsArchiveListing(null), false);
});

test('有能力清单但没这一条 → 不支持', () => {
  assert.equal(supportsArchiveListing(new Set<string>(['approvals-v1'])), false);
});

// ── missingRequiredCapabilities ──

test('必需能力位齐了 → 空数组', () => {
  const caps: Set<string> = new Set<string>(REQUIRED_CAPABILITIES);
  assert.deepEqual(missingRequiredCapabilities(caps), []);
});

test('缺哪条报哪条，顺序按必需清单', () => {
  assert.deepEqual(missingRequiredCapabilities(new Set<string>()), REQUIRED_CAPABILITIES);
  assert.deepEqual(missingRequiredCapabilities(new Set<string>(['approvals-v1'])), ['questions-v1']);
});
