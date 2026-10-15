/**
 * 鸿蒙 NetStack 错误码 → 病因分类 —— 供平台层把 `@ohos.net.http` / `@ohos.net.webSocket`
 * 抛出的数字错误码翻成 [NetworkFailureKind]。
 *
 * ## 为什么这张表放 core 而不是 platform
 *
 * 它只是一张**纯数字对照表**，不 import 任何 `@ohos`，因此在 node 下可以逐码断言 ——
 * 而分类错一次，用户看到的文案就错一次（把「地址填错了」报成「对方拒绝连接」，
 * 用户会去查防火墙而不是查端口）。平台层只做两件事：拿到错误码、查这张表。
 *
 * ## 码值来源
 *
 * 取自 SDK `@ohos.net.http.d.ts` 的 `@throws` 清单（2300001…2300999）。
 * 安卓那边是「按异常类判」（`SocketTimeoutException` / `UnknownHostException` /
 * `ConnectException` / SSL 家族 / 其他 `IOException`），这里是「按码判」，
 * 落到同一组分类上，于是 UI 文案表不需要改。
 */

import { NetworkFailureKind } from './ErrorMessages';

/** 超时（`2300028 Operation timeout`）。 */
export const NETSTACK_TIMEOUT_CODES: number[] = [2300028];

/**
 * 解析不了主机名 / 网络不可达。
 *
 * 含 `2300005`（代理名解析失败）与 `2300006`（主机名解析失败）—— 两者对用户是同一件事：
 * 「这个名字我找不到」，该改地址而不是改防火墙。
 */
export const NETSTACK_UNREACHABLE_CODES: number[] = [2300005, 2300006];

/** 连接被拒：对端没在监听（`2300007 Failed to connect to the server`）。 */
export const NETSTACK_REFUSED_CODES: number[] = [2300007];

/**
 * 连接中断：TLS 失败、socket 被重置、对端提前 EOF。
 *
 * 对应安卓里 `SSLException` + `SocketException` + `EOFException` 那一组 —— 它们对用户的
 * 含义相同（「谈了一半对方不讲了」），所以合成一类。
 */
export const NETSTACK_RESET_CODES: number[] = [
  2300018, // Transferred a partial file（提前 EOF）
  2300052, // The server returned nothing（空响应）
  2300055, // Failed to send data to the peer
  2300056, // Failed to receive data from the peer
  2300058, // Local SSL certificate error
  2300059, // The specified SSL cipher cannot be used
  2300060, // Invalid SSL peer certificate
  2300077, // The SSL CA certificate does not exist or is inaccessible
];

/** 查表：认不出的码（含 0、非 2300xxx、以及表里未列出的）一律 `OTHER`。 */
export function classifyNetStackCode(code: number): NetworkFailureKind {
  if (contains(NETSTACK_TIMEOUT_CODES, code)) {
    return NetworkFailureKind.TIMEOUT;
  }
  if (contains(NETSTACK_UNREACHABLE_CODES, code)) {
    return NetworkFailureKind.UNREACHABLE;
  }
  if (contains(NETSTACK_REFUSED_CODES, code)) {
    return NetworkFailureKind.REFUSED;
  }
  if (contains(NETSTACK_RESET_CODES, code)) {
    return NetworkFailureKind.RESET;
  }
  return NetworkFailureKind.OTHER;
}

function contains(codes: number[], code: number): boolean {
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] === code) {
      return true;
    }
  }
  return false;
}
