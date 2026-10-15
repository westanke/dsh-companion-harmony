import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkFailureKind } from '../../entry/src/main/ets/core/ErrorMessages.ts';
import {
  NETSTACK_REFUSED_CODES, NETSTACK_RESET_CODES, NETSTACK_TIMEOUT_CODES, NETSTACK_UNREACHABLE_CODES,
  classifyNetStackCode,
} from '../../entry/src/main/ets/core/NetworkFailureMapping.ts';

/**
 * NetStack 错误码 → 病因分类的测试。
 *
 * 这张表决定用户看到哪句文案，所以三类断言必须钉住：
 * 1. **逐码归类**：超时 / 解析不了主机 / 连接被拒 / 连接中断各走各的；
 * 2. **认不出就 OTHER**（不硬猜 —— 与错误码表「认不出保留原文」同一原则）；
 * 3. **四张表互不相交**：同一个码落进两类会让结果依赖查表顺序，那是隐性 bug。
 */

// ── 逐码归类 ──

test('2300028（操作超时）→ TIMEOUT', () => {
  assert.equal(classifyNetStackCode(2300028), NetworkFailureKind.TIMEOUT);
});

test('2300006（主机名解析失败）→ UNREACHABLE', () => {
  assert.equal(classifyNetStackCode(2300006), NetworkFailureKind.UNREACHABLE);
});

test('2300005（代理名解析失败）→ UNREACHABLE（对用户是同一件事：名字找不到）', () => {
  assert.equal(classifyNetStackCode(2300005), NetworkFailureKind.UNREACHABLE);
});

test('2300007（连不上服务器）→ REFUSED（对端没在监听）', () => {
  assert.equal(classifyNetStackCode(2300007), NetworkFailureKind.REFUSED);
});

test('TLS 与 socket 家族（2300018/2300052/2300055/2300056/2300058/2300059/2300060/2300077）→ RESET', () => {
  const resetFamily: number[] = [2300018, 2300052, 2300055, 2300056, 2300058, 2300059, 2300060, 2300077];
  for (const code of resetFamily) {
    assert.equal(classifyNetStackCode(code), NetworkFailureKind.RESET, `码 ${code} 应归 RESET`);
  }
});

// ── 认不出就 OTHER ──

test('其余已列在 SDK 文档里的码一律 OTHER，不硬猜', () => {
  // 这些码在 @ohos.net.http.d.ts 的 @throws 清单里，但不属于上面四类病因。
  const otherCodes: number[] = [
    2300001, // 协议不支持
    2300003, // URL 非法
    2300008, // 服务器响应非法
    2300009, // 访问远端资源被拒
    2300016, // HTTP2 帧层错误
    2300023, // 写本地失败
    2300025, // 上传失败
    2300026, // 读本地失败
    2300027, // 内存不足
    2300047, // 重定向次数超限
    2300061, // HTTP 编码格式非法
    2300063, // 文件超限
    2300070, // 远端磁盘满
    2300073, // 远端文件已存在
    2300078, // 远端文件不存在
    2300094, // 鉴权错误
    2300999, // 未知错误
  ];
  for (const code of otherCodes) {
    assert.equal(classifyNetStackCode(code), NetworkFailureKind.OTHER, `码 ${code} 应归 OTHER`);
  }
});

test('0（无错误码）/ 负数 / 非 NetStack 域的码都是 OTHER', () => {
  assert.equal(classifyNetStackCode(0), NetworkFailureKind.OTHER);
  assert.equal(classifyNetStackCode(-1), NetworkFailureKind.OTHER);
  // 401 / 201 这类是参数校验码，不是网络病因，不该被误判成某类网络故障。
  assert.equal(classifyNetStackCode(401), NetworkFailureKind.OTHER);
  assert.equal(classifyNetStackCode(999999), NetworkFailureKind.OTHER);
});

// ── 表的结构不变量 ──

test('四张表互不相交（同一个码落进两类会让结果依赖查表顺序）', () => {
  const tables: number[][] = [
    NETSTACK_TIMEOUT_CODES, NETSTACK_UNREACHABLE_CODES, NETSTACK_REFUSED_CODES, NETSTACK_RESET_CODES,
  ];
  for (let i = 0; i < tables.length; i++) {
    for (let k = i + 1; k < tables.length; k++) {
      for (const code of tables[i]) {
        assert.equal(tables[k].includes(code), false, `码 ${code} 同时出现在第 ${i} 与第 ${k} 张表里`);
      }
    }
  }
});

test('每张表内部无重复项', () => {
  const tables: number[][] = [
    NETSTACK_TIMEOUT_CODES, NETSTACK_UNREACHABLE_CODES, NETSTACK_REFUSED_CODES, NETSTACK_RESET_CODES,
  ];
  for (const table of tables) {
    assert.equal(new Set(table).size, table.length);
  }
});

test('所有表项都是正的 2300xxx 域码（搬家时别把别的域码写进来）', () => {
  const tables: number[][] = [
    NETSTACK_TIMEOUT_CODES, NETSTACK_UNREACHABLE_CODES, NETSTACK_REFUSED_CODES, NETSTACK_RESET_CODES,
  ];
  for (const table of tables) {
    for (const code of table) {
      assert.ok(code > 2300000 && code < 2310000, `码 ${code} 不在 NetStack 域内`);
    }
  }
});

test('分类结果只会是这五个枚举值之一（没有 undefined 漏网）', () => {
  const kinds: NetworkFailureKind[] = [
    NetworkFailureKind.TIMEOUT, NetworkFailureKind.UNREACHABLE, NetworkFailureKind.REFUSED,
    NetworkFailureKind.RESET, NetworkFailureKind.OTHER,
  ];
  const samples: number[] = [2300028, 2300005, 2300006, 2300007, 2300052, 2300999, 0, 42];
  for (const code of samples) {
    assert.ok(kinds.includes(classifyNetStackCode(code)), `码 ${code} 的分类不在枚举里`);
  }
});
