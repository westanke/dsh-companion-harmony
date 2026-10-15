/**
 * Kotlin 文本语义的复刻（空白判定 / 裁剪）—— 供 MentionQuery、ComposerSendPolicy、
 * 聊天表现层等所有「纯字符串逻辑」共用。
 *
 * 为什么要单独复刻而不用 JS 自带的 `/\s/` 与 `String.trim()`：
 * Kotlin 的 `Char.isWhitespace()` 实现是 `Character.isWhitespace(c) || Character.isSpaceChar(c)`，
 * 与 JS 的 `\s` 只差**一个字符**：`U+FEFF`。JS 的 `\s` 把它当空白（历史原因，BOM 曾被当作
 * ZWNBSP），而 Java/Kotlin 两种判定都不认它。
 *
 * 这一个字符的差异会变成真实的路人可见的 bug：用户在输入框里粘进一个 BOM 字符，
 * Kotlin 侧认为「有内容」（于是发送键可点），我们的实现若跟着 `\s` 认为「全是空白」
 * （于是发送键灰掉）—— 两端行为不一致，而这类不一致最难查。所以这里显式按 Kotlin 的
 * 字符集合判定，一个字都不差。
 */

/**
 * Kotlin `Char.isWhitespace()` 的完整字符集：
 * - `Character.isWhitespace`：TAB..CR、0x1C..0x1F、以及「非换行类分隔符」；
 * - `Character.isSpaceChar`：Unicode 类别 Zs / Zl / Zp 全部（含 U+00A0、U+2007、U+202F）。
 * 两者的并集恰好等价于 JS 的 `\s` **去掉 U+FEFF**，但这里仍写成显式区间，
 * 免得日后有人"顺手优化"成 `/\s/` 时把这处差异重新引回来。
 */
export function isKotlinWhitespace(ch: string): boolean {
  if (ch.length === 0) {
    return false;
  }
  const c: number = ch.charCodeAt(0);
  if (c === 0x09 || c === 0x0A || c === 0x0B || c === 0x0C || c === 0x0D) {
    return true;
  }
  if (c === 0x1C || c === 0x1D || c === 0x1E || c === 0x1F) {
    return true;
  }
  if (c === 0x20 || c === 0x00A0 || c === 0x1680) {
    return true;
  }
  // Zs 主区间：U+2000..U+200A（其中 U+2007 是数字用的空格，Kotlin 也算）。
  if (c >= 0x2000 && c <= 0x200A) {
    return true;
  }
  // Zl / Zp 与窄空格：U+2028 行分隔、U+2029 段分隔、U+202F 窄不换行空格、U+205F、U+3000 全角空格。
  if (c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000) {
    return true;
  }
  return false;
}

/**
 * Kotlin `CharSequence.isBlank()`：空串，或**每一个**字符都是空白。
 *
 * 注意「空白」用的是上面那套 Kotlin 集合，所以 U+FEFF 不算空白 —— 一个只含 BOM 的
 * 输入框在 Kotlin 侧是有内容的。
 */
export function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!isKotlinWhitespace(text.charAt(i))) {
      return false;
    }
  }
  return true;
}

/** Kotlin `CharSequence.isNotBlank()`。 */
export function isNotBlank(text: string): boolean {
  return !isBlank(text);
}

/** Kotlin `String.trim()`：去掉首尾的 Kotlin 空白字符。 */
export function trimText(value: string): string {
  let start: number = 0;
  let end: number = value.length;
  while (start < end && isKotlinWhitespace(value.charAt(start))) {
    start++;
  }
  while (end > start && isKotlinWhitespace(value.charAt(end - 1))) {
    end--;
  }
  return value.substring(start, end);
}

/**
 * Kotlin `String.trimEnd()`（去掉结尾的 Kotlin 空白字符）。
 *
 * 为 `HarnessViewModel.sendMessage` 补：源里判「这一行是不是斜杠命令」时用的是
 * `text.trimEnd()`（只削**结尾**空白，行首空白保留不动，因为 `/` 必须在行首），
 * 而现有的 `trimText` 是首尾都去、`trimEndChar` 只认单个指定字符，都不是这个语义。
 */
export function trimEndText(value: string): string {
  let end: number = value.length;
  while (end > 0 && isKotlinWhitespace(value.charAt(end - 1))) {
    end--;
  }
  return value.substring(0, end);
}

/**
 * Kotlin `String.trim(vararg chars)`：只去掉指定的字符。
 *
 * 注意与无参 `trim()` 的区别：给了字符就不再按空白判定，只按**这一个字符**比对
 * （`MentionQuery` 里的 `trim('/')`、`cwdAbsolute.trimEnd('/')` 都依赖这个语义）。
 */
export function trimStartChar(value: string, ch: string): string {
  let start: number = 0;
  while (start < value.length && value.charAt(start) === ch) {
    start++;
  }
  return value.substring(start);
}

/** Kotlin `String.trimEnd(vararg chars)` 的单字符形态。 */
export function trimEndChar(value: string, ch: string): string {
  let end: number = value.length;
  while (end > 0 && value.charAt(end - 1) === ch) {
    end--;
  }
  return value.substring(0, end);
}

/** Kotlin `String.trim(vararg chars)` 的单字符形态（首尾都去）。 */
export function trimChar(value: string, ch: string): string {
  return trimEndChar(trimStartChar(value, ch), ch);
}
