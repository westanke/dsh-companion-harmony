/**
 * 输入框上方两个补全面板的**判据** —— 移植自原工程 `ui/ChatScreen.kt` 的
 * `MentionSuggestions`（2139–2255 行）与 `commandSuggestions` / `CommandSuggestions`
 * （2257–2326 行）。
 *
 * ## 为什么把判据抽出来，而不是写在界面里
 *
 * 三个理由，条条都踩过：
 *
 * 1. **面板可见性判据有两处消费者**：真正画面板的那一处，和「告诉外层抽屉别响应滑动手势」
 *    的那一处（`composerOverlayActive`）。两处各写一份判据迟早会漂移成"看到的面板关着
 *    手势却没关"或反之 —— 源工程把 `commandSuggestions` 抽成独立函数就是为了这个。
 * 2. **过滤/排序/限量是纯字符串逻辑**，边界情况多（空查询、大小写、目录优先、超大目录），
 *    值得单测覆盖；混在 `@Component` 里就只能靠手点验证。
 * 3. `absolute()` 已单独在 `MentionQuery.ts` 里，这里只负责"该列哪几条"，各管一段。
 *
 * ## 与 Kotlin 的两处口径
 *
 * - Kotlin 的 `contains(query, ignoreCase = true)` / `startsWith(query, ignoreCase = true)`
 *   用 `toLowerCase()` 两边化之后比对；这里照做（不能直接用 `includes`，它区分大小写）。
 * - `take(n)` 对应 `slice(0, n)`；`sortedWith(compareByDescending…thenBy…)` 是**稳定排序**，
 *   ArkTS 的 `Array.prototype.sort` 在 V8 上同样稳定，原序在并列时得以保留。
 */

import { CommandDescriptor, FileEntry } from './Models';
import { activeStart } from './MentionQuery';
import { isKotlinWhitespace } from './TextPredicates';

/** `@` 面板的候选上限。源工程用 50 —— 列表本身可滚动，截太狠等于让人找不到。 */
const MENTION_LIMIT: number = 50;

/** `/` 命令面板的候选上限。源工程用 5 —— 命令本来就少，这一条基本不会触发。 */
const COMMAND_LIMIT: number = 5;

/** 小写化的包含判定（复刻 Kotlin `contains(ignoreCase = true)`）。 */
function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** 小写化的前缀判定（复刻 Kotlin `startsWith(ignoreCase = true)`）。 */
function startsWithIgnoreCase(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

/** Kotlin 的 `String.compareTo`：逐 UTF-16 码元比对，与 JS 的 `<` / `>` 同语义。 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * `@` 面板此刻列出的候选。
 *
 * `entries === null` 表示**还没读到**（见 ViewModel 的三态约定），此时返回空列表 ——
 * 界面要的是"没有可列的候选"，而"读不到 / 还没读"由面板自己按 `failed` 判据说话，
 * 不能在这里混成一个空目录。
 *
 * 排序：**目录优先**，其次按小写名升序。目录排前面是因为"`@` 一个文件夹继续往里选"
 * 是很常见的动作，混排时文件夹总被文件名淹掉。
 *
 * 限量：`filter` / `sort` 跑在完整 `entries` 上，超大目录下不设上限会让每次击键都重算
 * 几万条 —— 所以先排序再截断，而不是先截断（否则截到的可能全不是目录）。
 */
export function mentionMatches(entries: FileEntry[] | null, query: string): FileEntry[] {
  if (entries === null) {
    return [];
  }
  const matched: FileEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (containsIgnoreCase(entries[i].name, query)) {
      matched.push(entries[i]);
    }
  }
  matched.sort((a: FileEntry, b: FileEntry): number => {
    const aDir: boolean = a.isDirectory();
    const bDir: boolean = b.isDirectory();
    if (aDir !== bDir) {
      // 目录在前（降序），与 `compareByDescending { it.kind == "directory" }` 一致。
      return aDir ? -1 : 1;
    }
    return compareCodeUnits(a.name.toLowerCase(), b.name.toLowerCase());
  });
  return matched.slice(0, MENTION_LIMIT);
}

/**
 * `/` 命令面板此刻会显示哪几条（空列表 = 不显示）。
 *
 * 判据：**整行以斜杠开头**，且斜杠之后到末尾**没有空白**（命令名是行首语法，中间一空格
 * 就说明用户在打参数、不是还在挑命令）。两个条件都成立才按前缀过滤。
 *
 * 注意 `removePrefix("/")` 在 Kotlin 里只去**一个**前缀斜杠，所以这里也只用
 * `substring(1)`，不能写成 `replace`。
 */
export function commandSuggestions(value: string, commands: CommandDescriptor[]): CommandDescriptor[] {
  if (!value.startsWith('/')) {
    return [];
  }
  const query: string = value.substring(1);
  for (let i = 0; i < query.length; i++) {
    if (isKotlinWhitespace(query.charAt(i))) {
      return [];
    }
  }
  const matched: CommandDescriptor[] = [];
  for (let i = 0; i < commands.length; i++) {
    if (startsWithIgnoreCase(commands[i].name, query)) {
      matched.push(commands[i]);
    }
  }
  return matched.slice(0, COMMAND_LIMIT);
}

/**
 * 输入框上方是否有补全面板开着 —— 供外层抽屉据此关掉横向滑动手势。
 *
 * 两个面板**互斥**：`/` 只在整行以斜杠开头时才出（行首语法），`@` 只在光标落在一个提及
 * 词里时才出，同一时刻不可能同时成立。这个函数只回答"有没有"，不回答"是哪一个" ——
 * 面板内部仍按 `activeStart` 优先 / 其次命令的同款顺序渲染（万一将来判据放宽，斜杠优先，
 * 避免两个列表叠在一起）。
 */
export function composerOverlayActive(value: string, commands: CommandDescriptor[]): boolean {
  return activeStart(value) !== null || commandSuggestions(value, commands).length > 0;
}
