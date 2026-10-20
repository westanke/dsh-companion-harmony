/**
 * 工具调用专用块 —— 对标官方 Web 的 ReadBlock / TerminalBlock / DiffBlock。
 *
 * 对应源工程 `data/ChatToolBlocks.kt`（源 v2.2.43 新增，对标官方 Web 第一梯队）。
 *
 * ## 为什么有这一层
 *
 * 工具调用在消息流里此前只有一种长相：工具名 + 格式化后的 arguments + 结果正文。
 * 而三个最常用的工具其实各有**语义化的长相**：`read` 是「文件路径 + 带行号正文」、
 * `bash` 是「终端提示符 + 命令 + 输出」、`edit`/`write` 是「改动前后对照」。
 * 官方 Web 就是这么渲染的。本文件负责把这份「长相」从原始调用里算出来交给表现层，
 * 表现层只管画 —— 解析口径与画法分离，才好在这里钉用例。
 *
 * ## 铁律：解析失败一律回落 Generic
 *
 * 专用块是**增强不是依赖**：arguments 不是合法 JSON 对象、字段缺失、类型不符，
 * 一律退回 Generic（显示格式化后的 arguments）。绝不因为「解析不出来」就丢内容 ——
 * 内核将来加字段、改字段，最坏结果是「少一个专用长相」，不能变成「消息空白」。
 * 用例 `tool-blocks.test.ts` 专门喂畸形输入钉住这条退路。
 *
 * ## 「空 arguments」与「arguments 是坏 JSON」是两回事
 *
 * 前者=「这个工具没有参数」，照常按工具名分发（`bash` 依然出终端块，只是命令为空）；
 * 只有后者才回落。用例里两条分别钉了 —— 这条区分不写下来，日后很容易被合并成一条。
 *
 * ## 一个类承载四种形态（而不是四个类型）
 *
 * ArkTS 不支持判别联合类型，`switch(kind)` 也没法把类型收窄到「Read 就一定是路径+正文」。
 * 所以这里用**单类 + `kind` 判别字段**：多余的字段留默认值，表现层先看 `kind` 再取值。
 * 拆成四个类看着更「干净」，但在 ArkTS 里反而要写四组空判，得不偿失。
 */

import { JsonAccess, JsonMap } from './JsonAccess';
import { isBlank } from './TextPredicates';
import { prettyToolArguments } from './ChatToolFormat';
import { ToolCallDetail } from './ChatPresentationTypes';

/** 专用块形态。`Generic` 是**兜底项**，不是「没识别出来」的意思——它就是「平铺参数」。 */
export enum ToolBlockKind {
  Generic = 0,
  Read = 1,
  Terminal = 2,
  Diff = 3,
}

export class ToolBlockView {
  kind: ToolBlockKind = ToolBlockKind.Generic;

  /** Generic：格式化后的 arguments（与工具详情里平铺的那份完全同源，见 `prettyToolArguments`）。 */
  formattedArguments: string = '';

  /** Read：文件路径（取 arguments 的 `file_path`，不从 result 的 `<path>` 里猜）。 */
  path: string = '';
  /** Read：从第几行起（内核可能不给，所以是 `null` 而不是 0 —— 0 会显示成「第 0 行起」）。 */
  offset: number | null = null;
  /** Read：读多少行，同上。 */
  limit: number | null = null;
  /** Read：正文（已剥 `<content>` 包装、已去首尾空行）。 */
  body: string = '';
  /** Read：正文是否自带 `1: ` 行号前缀；自带就不再由客户端补，否则会显示两遍。 */
  hasLineNumbers: boolean = false;

  /** Terminal：命令原文。 */
  command: string = '';
  /** Terminal：模型给这条命令写的一句话说明（很多调用不写，空了就不显示）。 */
  description: string = '';
  /** Terminal：输出（已剥 ANSI 转义）。 */
  output: string = '';
  /** Terminal：`result === null` = 还在跑。注意 `""` 是「跑完了、没输出」，两者不能混。 */
  running: boolean = false;

  /** Diff：改动前后。`oldText === null` 表示**新建文件**（`write` 的语义），不是「旧内容为空」。 */
  oldText: string | null = null;
  newText: string = '';
  /** Diff：`edit` 的 `replace_all`（是否替换了全部匹配）；`write` 恒 false。 */
  replaceAll: boolean = false;
}

/** `extractReadBody` 的结果（Kotlin 侧是 `Pair<String, Boolean>`，ArkTS 里用类更省事）。 */
export class ReadBody {
  body: string = '';
  hasLineNumbers: boolean = false;
}

const CONTENT_OPEN: string = '<content>';
const CONTENT_CLOSE: string = '</content>';

/** 内核行号前缀的长相：`1: `、`  12: ` 之类。**只认「数字 + 冒号 + 一个空格」**。 */
const LINE_NUMBER_PATTERN: RegExp = /^\s*\d+: /;

function newView(kind: ToolBlockKind): ToolBlockView {
  const v: ToolBlockView = new ToolBlockView();
  v.kind = kind;
  return v;
}

/**
 * 解析 arguments 文本，**三态刻意分开**（见文件头）：
 *
 * - 空串/纯空白 → 空对象（「没有参数」，照常分发）；
 * - 坏 JSON、或解析出来不是对象（`null` / 数组 / 标量）→ `null`（**唯一**触发回落的输入）；
 * - 合法对象 → 返回它。
 */
function parseArguments(raw: string): JsonMap | null {
  if (isBlank(raw)) {
    const empty: JsonMap = {};
    return empty;
  }
  const parsed: Object | null = JsonAccess.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonMap;
}

/** 去掉首尾的**空行**（不动行内缩进）——`<content>` 包装自带的前后换行不该显示成空行。 */
function trimBlankEdges(text: string): string {
  const lines: string[] = text.split('\n');
  let start: number = 0;
  let end: number = lines.length;
  while (start < end && isBlank(lines[start])) {
    start++;
  }
  while (end > start && isBlank(lines[end - 1])) {
    end--;
  }
  const kept: string[] = [];
  for (let i: number = start; i < end; i++) {
    kept.push(lines[i]);
  }
  return kept.join('\n');
}

/** 正文首行**非空行**是否带行号前缀（空行开头的正文也要能判出来）。 */
function looksLikeNumberedLines(text: string): boolean {
  const lines: string[] = text.split('\n');
  for (let i: number = 0; i < lines.length; i++) {
    const line: string = lines[i];
    if (isBlank(line)) {
      continue;
    }
    return LINE_NUMBER_PATTERN.test(line);
  }
  return false;
}

/**
 * 从 `read` 的结果里剥出正文。
 *
 * 内核把正文包在 `<content>…</content>` 里（前面还可能有 `<path>`/`<type>`）。
 * 没有包装时**正文退回原样** —— 降级路径也要能显示，不能因为格式变了就空白。
 * 行号判据统一在剥完之后判（自带行号就不再由客户端补，免两遍）。
 */
export function extractReadBody(result: string | null): ReadBody {
  const out: ReadBody = new ReadBody();
  if (result === null) {
    return out;
  }
  const open: number = result.indexOf(CONTENT_OPEN);
  if (open < 0) {
    out.body = result;
  } else {
    const close: number = result.lastIndexOf(CONTENT_CLOSE);
    if (close < open) {
      out.body = trimBlankEdges(result.substring(open + CONTENT_OPEN.length));
    } else {
      out.body = trimBlankEdges(result.substring(open + CONTENT_OPEN.length, close));
    }
  }
  out.hasLineNumbers = looksLikeNumberedLines(out.body);
  return out;
}

/**
 * 剥掉 ANSI 转义序列（终端输出带来的一堆颜色码，直接显示是乱码）。
 *
 * 手写扫描而不是一把大正则，因为**残缺序列**必须特殊处理：
 * - CSI（`ESC [` …）：参数字节（0x30–0x3F、0x20–0x2F）扫到**终止字节**（0x40–0x7E）才算闭合，
 *   整段吞掉；扫不到终止字节（例如输出被截断在参数中间）就只吞 `ESC[` 与已扫过的参数，
 *   **绝不吞掉后面真正的内容**；
 * - OSC（`ESC ]` …）：到 `BEL`(0x07) 或 `ST`(`ESC \`) 结束，**含结束符**一起吞；
 *   没闭合就吞到结尾（半截 OSC 后面跟着的往往也是序列尾巴，留着才是乱码）；
 * - 其余 `ESC` + 单字节序列：吞两个字符。
 */
export function stripAnsiEscapes(text: string): string {
  let out: string = '';
  let i: number = 0;
  while (i < text.length) {
    const ch: string = text.charAt(i);
    if (ch !== '\u001B') {
      out += ch;
      i++;
      continue;
    }
    const next: string = text.charAt(i + 1);
    if (next === '[') {
      let j: number = i + 2;
      while (j < text.length) {
        const c: number = text.charCodeAt(j);
        const isParam: boolean = (c >= 0x30 && c <= 0x3F) || (c >= 0x20 && c <= 0x2F);
        if (!isParam) {
          break;
        }
        j++;
      }
      const term: number = j < text.length ? text.charCodeAt(j) : -1;
      const closed: boolean = term >= 0x40 && term <= 0x7E;
      i = closed ? j + 1 : j;
      continue;
    }
    if (next === ']') {
      let j: number = i + 2;
      let end: number = -1;
      while (j < text.length) {
        const c: number = text.charCodeAt(j);
        if (c === 0x07) {
          end = j + 1;
          break;
        }
        if (c === 0x1B && text.charAt(j + 1) === '\\') {
          end = j + 2;
          break;
        }
        j++;
      }
      i = end === -1 ? text.length : end;
      continue;
    }
    if (next.length > 0) {
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}

function readViewOf(args: JsonMap, result: string | null): ToolBlockView {
  const v: ToolBlockView = newView(ToolBlockKind.Read);
  const path: string | null = JsonAccess.str(args, 'file_path');
  v.path = path === null ? '' : path;
  v.offset = JsonAccess.num(args, 'offset');
  v.limit = JsonAccess.num(args, 'limit');
  const extracted: ReadBody = extractReadBody(result);
  v.body = extracted.body;
  v.hasLineNumbers = extracted.hasLineNumbers;
  return v;
}

function terminalViewOf(args: JsonMap, result: string | null): ToolBlockView {
  const v: ToolBlockView = newView(ToolBlockKind.Terminal);
  const command: string | null = JsonAccess.str(args, 'command');
  v.command = command === null ? '' : command;
  const description: string | null = JsonAccess.str(args, 'description');
  v.description = description === null ? '' : description;
  v.output = stripAnsiEscapes(result === null ? '' : result);
  v.running = result === null;
  return v;
}

/** `edit` 与 `write` 共用：`write` 的 `oldText` 恒为 `null`（新建文件的语义）。 */
function diffViewOf(args: JsonMap, isWrite: boolean): ToolBlockView {
  const v: ToolBlockView = newView(ToolBlockKind.Diff);
  const path: string | null = JsonAccess.str(args, 'file_path');
  v.path = path === null ? '' : path;
  if (isWrite) {
    const content: string | null = JsonAccess.str(args, 'content');
    v.newText = content === null ? '' : content;
    return v;
  }
  v.oldText = JsonAccess.str(args, 'old_string');
  const next: string | null = JsonAccess.str(args, 'new_string');
  v.newText = next === null ? '' : next;
  const all: boolean | null = JsonAccess.bool(args, 'replace_all');
  v.replaceAll = all === null ? false : all;
  return v;
}

/**
 * 把一次工具调用投影成「该用什么长相显示」。
 *
 * 分发按**工具名**（内核定的固定名，实测样本里就这几个）：
 * `bash` → 终端、`read`/`read_image` → 文件、`edit` → 改动对照、`write` → 新建文件。
 * 其余（`grep`/`glob`/`todo`/未知）一律 Generic —— **不做「猜参数」的启发式**：
 * 猜错会把命令显示成文件、把文件显示成命令，比不猜更糟。
 */
export function toolBlockView(tool: ToolCallDetail): ToolBlockView {
  const args: JsonMap | null = parseArguments(tool.argumentsJson);
  if (args === null) {
    const v: ToolBlockView = newView(ToolBlockKind.Generic);
    v.formattedArguments = prettyToolArguments(tool.argumentsJson);
    return v;
  }
  const name: string = tool.name;
  if (name === 'bash') {
    return terminalViewOf(args, tool.result);
  }
  if (name === 'read' || name === 'read_image') {
    return readViewOf(args, tool.result);
  }
  if (name === 'edit') {
    return diffViewOf(args, false);
  }
  if (name === 'write') {
    return diffViewOf(args, true);
  }
  const generic: ToolBlockView = newView(ToolBlockKind.Generic);
  generic.formattedArguments = prettyToolArguments(tool.argumentsJson);
  return generic;
}
