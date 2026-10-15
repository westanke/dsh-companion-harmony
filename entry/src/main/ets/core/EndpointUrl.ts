/**
 * 端点地址归一化工具 —— 对应原工程 `DshClient.normalizeEndpoint` 及
 * `ConnectionShare` / `HostStore` 里各自的私有归一逻辑。
 *
 * 刻意**不依赖 URL 解析器**（ArkTS 需要 `@ohos.url`，Node 才有全局 URL），
 * 全部用字符串操作实现，从而同一份代码既能编进 HAP、又能在 node 上直接跑单测。
 */

/** 接口前缀 `/api/v1` 不是地址的一部分。 */
export const API_SUFFIX = '/api/v1';

function startsWithHttp(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** 取 URL 中「协议+主机」之后、且不含查询串与锚点的路径部分（保持原样编码）。 */
export function encodedPathOf(url: string): string {
  const schemeEnd: number = url.indexOf('://');
  if (schemeEnd < 0) {
    return '';
  }
  let rest: string = url.substring(schemeEnd + 3);
  const hash: number = rest.indexOf('#');
  if (hash >= 0) {
    rest = rest.substring(0, hash);
  }
  const q: number = rest.indexOf('?');
  if (q >= 0) {
    rest = rest.substring(0, q);
  }
  const slash: number = rest.indexOf('/');
  if (slash < 0) {
    return '/';
  }
  return rest.substring(slash);
}

/**
 * 严格归一：去首尾空白与尾斜杠，必须以 `http(s)://` 开头（否则抛错），
 * 若路径不以 `/api/v1` 结尾则追加之。
 *
 * 这是**唯一故意抛异常**的归一入口（对应 Kotlin 的 `require`）。
 */
export function normalizeEndpoint(value: string): string {
  const input: string = value.trim().replace(/\/+$/, '');
  if (!startsWithHttp(input)) {
    throw new Error('Endpoint must start with http:// or https://');
  }
  const path: string = encodedPathOf(input).replace(/\/+$/, '');
  return path.endsWith(API_SUFFIX) ? input : `${input}${API_SUFFIX}`;
}

/** 去掉末尾的 `/api/v1` 后缀（大小写敏感），并再次去尾斜杠。 */
export function stripApiSuffix(value: string): string {
  let v: string = value;
  if (v.endsWith(API_SUFFIX)) {
    v = v.substring(0, v.length - API_SUFFIX.length).replace(/\/+$/, '');
  }
  return v;
}

/**
 * ConnectionShare 口径的基地址归一：去首尾空白与尾斜杠、去掉 `/api/v1`、协议名统一小写。
 * 幂等，不抛异常。
 */
export function shareNormalizeBaseUrl(raw: string): string {
  let value: string = raw.trim().replace(/\/+$/, '');
  value = stripApiSuffix(value);
  if (value.toLowerCase().startsWith('http://')) {
    return 'http://' + value.substring(7);
  }
  if (value.toLowerCase().startsWith('https://')) {
    return 'https://' + value.substring(8);
  }
  return value;
}

/**
 * HostStore 口径的基地址归一：缺协议补 `http://`，再走严格归一后去掉 `/api/v1`；
 * 严格归一抛错时退回「补协议后的原文」。
 */
export function storeNormalizeBaseUrl(raw: string): string {
  const trimmed: string = raw.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) {
    return '';
  }
  const withScheme: string = startsWithHttp(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return stripApiSuffix(normalizeEndpoint(withScheme));
  } catch (e) {
    return withScheme;
  }
}

/** 基础校验：至少能在去掉 `/api/v1` 后得到一个带主机名的 http(s) 地址。 */
export function isUsableBaseUrl(raw: string): boolean {
  const normalized: string = shareNormalizeBaseUrl(raw);
  let schemeLength: number = 0;
  if (normalized.startsWith('http://')) {
    schemeLength = 7;
  } else if (normalized.startsWith('https://')) {
    schemeLength = 8;
  } else {
    return false;
  }
  const authority: string = normalized.substring(schemeLength).split('/')[0];
  const host: string = authority.split(':')[0];
  return host.trim().length > 0;
}

/** 从基地址取主机名：去掉协议、路径、查询串、锚点与端口；IPv6 去掉方括号。 */
export function hostNameOf(baseUrl: string): string {
  const withoutScheme: string = baseUrl
    .replace(/^http:\/\//, '')
    .replace(/^https:\/\//, '');
  let authority: string = withoutScheme.split('/')[0];
  authority = authority.split('?')[0];
  authority = authority.split('#')[0];
  let host: string;
  if (authority.startsWith('[')) {
    host = authority.substring(0, authority.indexOf(']')).replace('[', '');
  } else {
    host = authority.split(':')[0];
  }
  return host.trim().length > 0 ? host : baseUrl.trim();
}
