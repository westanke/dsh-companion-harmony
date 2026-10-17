/**
 * 思考条的两个纯函数 —— 移植自原工程 `ui/ChatScreen.kt`（对应上游的 `ChatThinkBarTest`）。
 *
 * 这两条规则本身与渲染无关，但**正是用户实际看到的行为**：
 * 取错来源会拿一段旧思考冒充「正在想」，截错位置会让用户永远看不到最要紧的结尾那几句。
 */

import { ChatItemKind, LiveChatBlock } from './ChatPresentation';
import { trimText } from './TextPredicates';

/**
 * 折叠用的「空白」集合：`[ \t\n\x0B\f\r]`，**正好是 Java 正则 `\s` 的默认取值**。
 *
 * 刻意**不**用 `/\s+/`：JS 的 `\s` 还包含 U+00A0（不换行空格）、U+3000（全角空格）、
 * U+2000–200A 与 U+FEFF，而源工程用的是 Kotlin 的 `Regex("\\s+")` —— 底层是 Java 正则，
 * 默认**不**开 `UNICODE_CHARACTER_CLASS`，那些都不算空白。`/\s+/` 会把中文思考里的
 * 全角空格悄悄折成普通空格，看着只是「排版好了一点」，实际是行为不一致。
 */
const THINK_WHITESPACE: RegExp = /[ \t\n\x0B\f\r]+/g;

/**
 * 从流式这一段里取出「当前思考」的原文：只认 REASONING 块，按原顺序用空格接起来。
 *
 * 与网页版 `setLive` 同一口径：`filter(kind === "reasoning")` 后 `join(" ")`。
 * **只取流式**是刻意的 —— 历史里的思考已在列表层被过滤掉，翻历史时这条思考条必须消失，
 * 否则会拿一段旧思考冒充「正在想」。
 */
export function liveThinkingText(blocks: LiveChatBlock[]): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind === ChatItemKind.REASONING) {
      parts.push(blocks[i].text);
    }
  }
  return parts.join(' ');
}

/**
 * 思考条那一行的文字：空白折成单个空格、去掉首尾，超过 `maxChars` 只留**尾部**。
 *
 * 「留尾巴」是照网页版来的：思考的开头通常是一句套话，真正说明「现在在干什么」的在结尾。
 * 数值与网页版一致：超长时取 `"…"` 加上末尾 `maxChars` 个字符。
 *
 * 首尾裁剪用 `trimText`（Kotlin `trim()` 的等价实现，宽集、不含 U+FEFF），
 * **不能**直接用 `String.prototype.trim()`：它会把 U+FEFF 剪掉，而源工程不会。
 * 折叠用窄集、裁剪用宽集，两处不同是源工程本身就有的差异。
 */
export function thinkBarText(raw: string, maxChars: number = 140): string {
  const text: string = thinkBarFullText(raw);
  if (text.length <= maxChars) {
    return text;
  }
  return `…${text.substring(text.length - maxChars)}`;
}

/**
 * 展开态用的**全文**：同样折空白、去首尾，但**不截断**。
 *
 * 与 `thinkBarText` 同一套折空白与裁剪口径（宽度必须一致，否则展开后的第一行会与
 * 折叠态对不上，看起来像换了段文字）；差别只在「留不留尾巴」。
 * 单列一个函数而不是传 `Number.MAX_SAFE_INTEGER`：那是「用参数上限冒充不截断」，
 * 读代码的人得反推语义。
 */
export function thinkBarFullText(raw: string): string {
  return trimText(raw.replace(THINK_WHITESPACE, ' '));
}
