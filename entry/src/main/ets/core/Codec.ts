/**
 * 纯逻辑编解码工具：UTF-8 与 Base64。
 *
 * 为什么不用平台 API：同一份源码要既能编进 HAP（ArkTS 无全局 TextEncoder/atob），
 * 又能被 node 直接跑单测。全部手写后，行为在两端完全一致，也便于对照 Kotlin 的
 * `Base64.getEncoder()/getUrlEncoder()` 语义。
 */

/** 标准字母表（含 `+` `/`）。 */
const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** URL-safe 字母表（含 `-` `_`）。 */
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 把普通数组收敛成 Uint8Array（ArkTS 下逐位赋值最稳）。 */
export function toBytes(values: number[]): Uint8Array {
  const out: Uint8Array = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i] & 0xFF;
  }
  return out;
}

/** 字符串 → UTF-8 字节（正确处理代理对与四字节码点）。 */
export function utf8Encode(value: string): Uint8Array {
  const out: number[] = [];
  let i: number = 0;
  while (i < value.length) {
    let code: number = value.charCodeAt(i);
    i++;
    if (code >= 0xD800 && code <= 0xDBFF && i < value.length) {
      const low: number = value.charCodeAt(i);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xC0 | (code >> 6));
      out.push(0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
      out.push(0xE0 | (code >> 12));
      out.push(0x80 | ((code >> 6) & 0x3F));
      out.push(0x80 | (code & 0x3F));
    } else {
      out.push(0xF0 | (code >> 18));
      out.push(0x80 | ((code >> 12) & 0x3F));
      out.push(0x80 | ((code >> 6) & 0x3F));
      out.push(0x80 | (code & 0x3F));
    }
  }
  return toBytes(out);
}

/** UTF-8 字节 → 字符串；坏字节按 U+FFFD 处理，绝不抛异常。 */
export function utf8Decode(bytes: Uint8Array): string {
  let out: string = '';
  let i: number = 0;
  const n: number = bytes.length;
  while (i < n) {
    const first: number = bytes[i];
    let code: number = -1;
    let extra: number = 0;
    if (first < 0x80) {
      code = first;
    } else if ((first & 0xE0) === 0xC0) {
      code = first & 0x1F;
      extra = 1;
    } else if ((first & 0xF0) === 0xE0) {
      code = first & 0x0F;
      extra = 2;
    } else if ((first & 0xF8) === 0xF0) {
      code = first & 0x07;
      extra = 3;
    }
    if (code < 0) {
      out += '\uFFFD';
      i++;
      continue;
    }
    if (i + extra >= n) {
      out += '\uFFFD';
      i++;
      continue;
    }
    let ok: boolean = true;
    for (let k = 1; k <= extra; k++) {
      const cont: number = bytes[i + k];
      if ((cont & 0xC0) !== 0x80) {
        ok = false;
        break;
      }
      code = (code << 6) | (cont & 0x3F);
    }
    if (!ok) {
      out += '\uFFFD';
      i++;
      continue;
    }
    i += extra + 1;
    if (code > 0xFFFF) {
      const astral: number = code - 0x10000;
      out += String.fromCharCode(0xD800 + (astral >> 10));
      out += String.fromCharCode(0xDC00 + (astral & 0x3FF));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/** UTF-8 字节序标记（EF BB BF），解析分享链接时要整段跳过。 */
export const UTF8_BOM: Uint8Array = toBytes([0xEF, 0xBB, 0xBF]);

/**
 * 「严格」UTF-8 解码：与 [utf8Decode] 同一套解码逻辑，只在**出现坏字节时返回 null**。
 *
 * 为 `HarnessViewModel.importConfiguration` 补：源里用 `Charsets.UTF_8.newDecoder()`
 * 配 `CodingErrorAction.REPORT`，一遇到非法序列就抛 `CharacterCodingException`，
 * 于是「粘错了的分享链接」能被识别成一串解码失败而不是一段乱码。
 *
 * 这里把「坏字节 → 报错」的差异收敛成返回 null：`utf8Decode` 的坏字节分支
 * （首字节非法、续字节非法、被截断）全部改成直接返回 null，其余路径一字不动。
 */
export function utf8DecodeStrict(bytes: Uint8Array): string | null {
  let out: string = '';
  let i: number = 0;
  const n: number = bytes.length;
  while (i < n) {
    const first: number = bytes[i];
    let code: number = -1;
    let extra: number = 0;
    if (first < 0x80) {
      code = first;
    } else if ((first & 0xE0) === 0xC0) {
      code = first & 0x1F;
      extra = 1;
    } else if ((first & 0xF0) === 0xE0) {
      code = first & 0x0F;
      extra = 2;
    } else if ((first & 0xF8) === 0xF0) {
      code = first & 0x07;
      extra = 3;
    }
    if (code < 0) {
      return null;
    }
    if (i + extra >= n) {
      return null;
    }
    // 三字节形态里，E0 后面的首续字节必须是 A0..BF、ED 后面必须是 80..9F，
    // 否则会解出代理对或超范围码点 —— 严格解码器把这两种都当非法。
    if (extra === 2 && first === 0xE0 && bytes[i + 1] < 0xA0) {
      return null;
    }
    if (extra === 2 && first === 0xED && bytes[i + 1] > 0x9F) {
      return null;
    }
    if (extra === 3 && first === 0xF0 && bytes[i + 1] < 0x90) {
      return null;
    }
    if (extra === 3 && first === 0xF4 && bytes[i + 1] > 0x8F) {
      return null;
    }
    for (let k = 1; k <= extra; k++) {
      const cont: number = bytes[i + k];
      if ((cont & 0xC0) !== 0x80) {
        return null;
      }
      code = (code << 6) | (cont & 0x3F);
    }
    i += extra + 1;
    if (code > 0xFFFF) {
      const astral: number = code - 0x10000;
      out += String.fromCharCode(0xD800 + (astral >> 10));
      out += String.fromCharCode(0xDC00 + (astral & 0x3FF));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/** Base64 编码；`urlSafe` 选字母表，`padded` 决定是否补 `=`。 */
export function base64Encode(bytes: Uint8Array, urlSafe: boolean, padded: boolean): string {
  const alphabet: string = urlSafe ? B64_URL : B64_STD;
  let out: string = '';
  let i: number = 0;
  while (i + 3 <= bytes.length) {
    const n: number = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet.charAt((n >> 18) & 63) + alphabet.charAt((n >> 12) & 63)
      + alphabet.charAt((n >> 6) & 63) + alphabet.charAt(n & 63);
    i += 3;
  }
  const rest: number = bytes.length - i;
  if (rest === 1) {
    const n: number = bytes[i] << 16;
    out += alphabet.charAt((n >> 18) & 63) + alphabet.charAt((n >> 12) & 63);
    if (padded) {
      out += '==';
    }
  } else if (rest === 2) {
    const n: number = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet.charAt((n >> 18) & 63) + alphabet.charAt((n >> 12) & 63)
      + alphabet.charAt((n >> 6) & 63);
    if (padded) {
      out += '=';
    }
  }
  return out;
}

/** 取某字符在指定字母表下的 6 位值；不属于该字母表返回 -1（`=` 请先排除）。 */
function b64Value(ch: string, urlSafe: boolean): number {
  if (ch >= 'A' && ch <= 'Z') {
    return ch.charCodeAt(0) - 65;
  }
  if (ch >= 'a' && ch <= 'z') {
    return ch.charCodeAt(0) - 97 + 26;
  }
  if (ch >= '0' && ch <= '9') {
    return ch.charCodeAt(0) - 48 + 52;
  }
  if (ch === '=') {
    return -2;
  }
  if (urlSafe) {
    if (ch === '-') {
      return 62;
    }
    if (ch === '_') {
      return 63;
    }
    return -1;
  }
  if (ch === '+') {
    return 62;
  }
  if (ch === '/') {
    return 63;
  }
  return -1;
}

/** 两种字母表的并集字符集合（对应 Kotlin 的 `isBase64Char` 过滤器）。 */
function isBase64Char(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
    || ch === '+' || ch === '/' || ch === '-' || ch === '_' || ch === '=';
}

/**
 * 单变体 Base64 解码。
 *
 * 语义对齐 Kotlin 的 `Base64.getUrlDecoder()/getDecoder().decode()`：
 * - 先剔掉字母表之外的字符（结尾粘上的句号、引号、标签文字），`=` 照 Kotlin 计入长度校验；
 * - 过滤后长度 `%4==1` 在任何变体下都不可能 → 直接判死；
 * - 出现**本变体字母表不认**的字符（如 url-safe 变体遇到 `+`）→ 判死，交由另一种变体重试。
 *
 * 返回 null 表示该变体下无法解码。
 */
export function base64DecodeStrict(text: string, urlSafe: boolean): Uint8Array | null {
  const values: number[] = [];
  let alphabetCount: number = 0;
  for (let i = 0; i < text.length; i++) {
    const ch: string = text.charAt(i);
    if (!isBase64Char(ch)) {
      continue;
    }
    alphabetCount++;
    const v: number = b64Value(ch, urlSafe);
    if (v === -2) {
      continue;
    }
    if (v < 0) {
      return null;
    }
    values.push(v);
  }
  if (alphabetCount === 0) {
    return null;
  }
  if (alphabetCount % 4 === 1) {
    return null;
  }
  const rest: number = values.length % 4;
  const out: number[] = [];
  let i: number = 0;
  while (i + 4 <= values.length) {
    const n: number = (values[i] << 18) | (values[i + 1] << 12) | (values[i + 2] << 6) | values[i + 3];
    out.push((n >> 16) & 0xFF);
    out.push((n >> 8) & 0xFF);
    out.push(n & 0xFF);
    i += 4;
  }
  if (rest === 2) {
    const n: number = (values[i] << 18) | (values[i + 1] << 12);
    out.push((n >> 16) & 0xFF);
  } else if (rest === 3) {
    const n: number = (values[i] << 18) | (values[i + 1] << 12) | (values[i + 2] << 6);
    out.push((n >> 16) & 0xFF);
    out.push((n >> 8) & 0xFF);
  }
  return toBytes(out);
}

/** 先按 URL-safe、再按标准字母表解码（对应 Kotlin 的两次 runCatching）。 */
export function base64DecodeEither(text: string): Uint8Array | null {
  const urlSafe: Uint8Array | null = base64DecodeStrict(text, true);
  if (urlSafe !== null) {
    return urlSafe;
  }
  return base64DecodeStrict(text, false);
}

/** 十六进制小写化字节（对应 Kotlin 的 `"%02x".format(byte)`）。 */
export function hexOf(bytes: Uint8Array): string {
  let out: string = '';
  for (let i = 0; i < bytes.length; i++) {
    const b: number = bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}
