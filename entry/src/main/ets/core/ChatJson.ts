/**
 * 聊天页呈现模型 —— **第二层：宽松取值**（从 `ChatPresentation.ts` 拆出）。
 *
 * `ChatJson` 把 kotlinx `JsonPrimitive` 的取值语义逐条复刻（`contentOrNull` 对数字/布尔原语
 * 也给字符串、对 `null` 给 null —— 这正是「缺键 vs 显式 null」在本层的分界），
 * 外加几个 Kotlin 标准库对应的小工具（`kotlinLines` / `trimStartWs` / `afterLast` / `firstLine`）。
 *
 * 拆分来龙去脉见 `ChatPresentation.ts` 文件头。
 */

import { JsonAccess, JsonMap } from './JsonAccess';
import { isBlank, isKotlinWhitespace, isNotBlank } from './TextPredicates';

// ---------------------------------------------------------------------------
// 宽松取值（复刻 kotlinx 的 JsonPrimitive 语义）
// ---------------------------------------------------------------------------

/**
 * kotlinx `JsonPrimitive` 的取值语义，逐条复刻。
 *
 * 与直接读 JS 对象的两处关键差异：
 * - `contentOrNull` 对**数字/布尔**原语也给字符串（`1` → `'1'`），而非只认字符串；
 *   但对 `null` 给 null —— 这正是「缺键 vs 显式 null」在本层的分界。
 * - `intOrNull` 认的是**整数且在 int32 范围内**；`1.5`、`1e12` 都给 null，
 *   而不是像 JS 的 `Number()` 那样悄悄接受。
 */
export class ChatJson {
  static obj(map: JsonMap | null, key: string): JsonMap | null {
    return JsonAccess.obj(map, key);
  }

  /** 对应 `JsonPrimitive.contentOrNull`。 */
  static str(map: JsonMap | null, key: string): string | null {
    const v: Object | null = JsonAccess.raw(map, key);
    if (v === null) {
      return null;
    }
    if (typeof v === 'string') {
      return v as string;
    }
    if (typeof v === 'number') {
      return `${v as number}`;
    }
    if (typeof v === 'boolean') {
      return (v as boolean) ? 'true' : 'false';
    }
    return null;
  }

  /** 对应 `JsonPrimitive.intOrNull`：非整数或越界一律 null。 */
  static int(map: JsonMap | null, key: string): number | null {
    const v: Object | null = JsonAccess.raw(map, key);
    if (v === null || typeof v !== 'number') {
      return null;
    }
    const n: number = v as number;
    if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
      return null;
    }
    return n;
  }

  /** 对应 `contentOrNull?.toBooleanStrictOrNull()`：只有字符串 `true`/`false` 认。 */
  static bool(map: JsonMap | null, key: string): boolean | null {
    const v: Object | null = JsonAccess.raw(map, key);
    if (v === null) {
      return null;
    }
    if (typeof v === 'boolean') {
      return v as boolean;
    }
    if (typeof v === 'string') {
      const s: string = v as string;
      if (s === 'true') {
        return true;
      }
      if (s === 'false') {
        return false;
      }
    }
    return null;
  }

  static arr(map: JsonMap | null, key: string): Object[] {
    return JsonAccess.arr(map, key);
  }

  /** 对应 `(a[member] as? JsonArray).mapNotNull { stringValue(field) }` + `distinct()`。 */
  static arrayLabels(map: JsonMap | null, member: string, field: string): string {
    const items: Object[] = ChatJson.arr(map, member);
    const values: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry: JsonMap | null = JsonAccess.asMap(items[i]);
      const label: string | null = ChatJson.str(entry, field);
      if (label !== null && isNotBlank(label) && values.indexOf(label) < 0) {
        values.push(label);
      }
    }
    return values.join(', ');
  }
}

// ---------------------------------------------------------------------------
// 文本工具（复刻 Kotlin 的 lineSequence / trimStart / substringAfterLast）
// ---------------------------------------------------------------------------

/** 对应 Kotlin `lineSequence()`：按 `\r\n` / `\n` / `\r` 三种行尾切分。 */
export function kotlinLines(value: string): string[] {
  const parts: string[] = [];
  let start: number = 0;
  let i: number = 0;
  while (i < value.length) {
    const ch: string = value.charAt(i);
    if (ch === '\n') {
      parts.push(value.substring(start, i));
      i++;
      start = i;
    } else if (ch === '\r') {
      parts.push(value.substring(start, i));
      i++;
      if (i < value.length && value.charAt(i) === '\n') {
        i++;
      }
      start = i;
    } else {
      i++;
    }
  }
  parts.push(value.substring(start));
  return parts;
}

/** 对应 Kotlin `trimStart()`（按 `Char.isWhitespace()` 口径，与 JS trimStart 只差 U+FEFF）。 */
export function trimStartWs(value: string): string {
  let i: number = 0;
  while (i < value.length && isKotlinWhitespace(value.charAt(i))) {
    i++;
  }
  return value.substring(i);
}

/** 对应 Kotlin `substringAfterLast(delimiter)`：找不到分隔符时返回原串。 */
export function afterLast(value: string, delimiter: string): string {
  const at: number = value.lastIndexOf(delimiter);
  return at < 0 ? value : value.substring(at + delimiter.length);
}

/** 对应 Kotlin `substringAfterLast(delimiter, missingDelimiterValue = "")`。 */
export function afterLastOrEmpty(value: string, delimiter: string): string {
  const at: number = value.lastIndexOf(delimiter);
  return at < 0 ? '' : value.substring(at + delimiter.length);
}

/** 对应 Kotlin `lineSequence().first()`。 */
export function firstLine(value: string): string {
  const at: number = value.indexOf('\n');
  if (at >= 0) {
    return value.substring(0, at);
  }
  const cr: number = value.indexOf('\r');
  return cr >= 0 ? value.substring(0, cr) : value;
}
