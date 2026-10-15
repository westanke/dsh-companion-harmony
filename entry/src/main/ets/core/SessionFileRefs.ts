/**
 * 从会话历史里提取「agent 提到过哪些文件」—— 移植自原工程 `data/SessionFileRefs.kt`（180 行）。
 *
 * ## 只认绝对路径
 *
 * 相对路径一律丢弃。它相对于谁是不确定的：`readme.md` 可能相对会话 `cwd`、相对工具
 * 默认目录、或只是命令参数里的一个词。猜错会把用户带到别的文件上，所以宁可他不列出。
 * （实测会话的 `cwd` 字段 71/71 全为空，连猜的起点都没有。）
 *
 * ## 为什么 `bash` 的 command 一律不解析（有意的取舍）
 *
 * shell 命令里的路径绝大多数不是「一个文件」：`grep -rn "foo" /src` 里是搜索范围、
 * `--out=$DIR/x` 里是变量、`echo "/etc/passwd"` 里是一段正文。都解析出来只会得到一堆
 * 点不开的路径，**误报比没有功能更糟**：它会训练用户忽略这个面板，于是真能打开的那些
 * 也被忽略掉。所以 UNPARSED_TOOLS 里的工具整体跳过，不做任何启发式猜测。
 *
 * 同理，`grep`/`glob` 也不在解析之列：它们的 `path` 是搜索目录而不是「被改动的文件」。
 * `path`（相对 `file_path` 的兜底键）只在 FILE_PATH_TOOLS 上才采信；未知工具仍然接受
 * `file_path`，因为这个键名本身已经足够明确，而它出现在 shell 命令里的可能性为零。
 *
 * 本模块是纯逻辑：不碰网络、不碰平台，可直接在单测里跑。
 */

import { JsonAccess, JsonMap } from './JsonAccess';
import { HistoryEntry } from './Models';
import { isNotBlank } from './TextPredicates';

/**
 * 会话里被 agent 提到过的一个文件路径。
 *
 * `path` 是**服务器上的绝对路径**，原样保留 —— 客户端无法把它映射成「哪个授权根 + 相对
 * 路径」，那一步必须交给服务端（`GET /roots/resolve`）。
 */
export class SessionFileRef {
  path: string;
  /** 在整个会话历史里出现的次数。 */
  count: number;
  /** 最后一次出现的事件序号。 */
  lastSeq: number;
  /**
   * agent 为这个交付物写的说明（只有来自 `deliverables/presented` 的才有）。
   *
   * 从工具参数里嗅出来的路径没有说明 —— 那时 agent 并没有「交付」的意思，
   * 只是顺手读写过这个文件。所以这个字段同时也是「它是正式交付物」的标记。
   */
  description: string | null;

  constructor(path: string, count: number, lastSeq: number, description: string | null = null) {
    this.path = path;
    this.count = count;
    this.lastSeq = lastSeq;
    this.description = description;
  }
}

/** 参数语义就是「一个文件」的工具；只有它们才采信兜底的 `path` 键。 */
const FILE_PATH_TOOLS: Set<string> = new Set<string>([
  'read', 'write', 'edit', 'multi_edit', 'notebook_edit', 'str_replace_editor',
]);

/**
 * 参数里多半是模式、变量或正文的工具：一律不解析。
 *
 * 见文件头的理由 —— 这里刻意不做「聪明」的启发式提取。
 */
const UNPARSED_TOOLS: Set<string> = new Set<string>(['bash', 'pwsh', 'run_code']);

/** Windows 盘符开头的绝对路径，例如 `C:\Users\x\a.txt`。 */
const WINDOWS_DRIVE: RegExp = /^[A-Za-z]:[\\/]/;

/** 绝对路径判定：以 `/` 开头，或以 Windows 盘符开头。 */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || WINDOWS_DRIVE.test(value);
}

/** 复刻 kotlinx `JsonPrimitive.contentOrNull`：数字/布尔原语也给字符串，`null` 给 null。 */
function refsStr(map: JsonMap | null, key: string): string | null {
  const value: Object | null = JsonAccess.raw(map, key);
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value as string;
  }
  if (typeof value === 'number') {
    return `${value as number}`;
  }
  if (typeof value === 'boolean') {
    return (value as boolean) ? 'true' : 'false';
  }
  return null;
}

/** 把任意 JSON 值收敛成数组；非数组给空数组（对应 Kotlin `as? JsonArray).orEmpty()`）。 */
function asArray(value: Object | null): Object[] {
  return value !== null && Array.isArray(value) ? value as Object[] : [];
}

/** 参数既可能是 JSON 字符串（实测形态），也可能是已解析好的对象；两者都接受。 */
function asObject(value: Object | null): JsonMap | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return JsonAccess.asMap(JsonAccess.parse(value as string));
  }
  return JsonAccess.asMap(value);
}

/** 工具名（+ 参数）配对：名字用来决定要不要采信参数里的路径。 */
class ToolCandidate {
  name: string | null;
  argumentsValue: Object | null;

  constructor(name: string | null, argumentsValue: Object | null) {
    this.name = name;
    this.argumentsValue = argumentsValue;
  }
}

function record(map: Map<string, SessionFileRef>, raw: string | null, seq: number): void {
  const path: string | null = raw !== null && isNotBlank(raw) && isAbsolutePath(raw) ? raw : null;
  if (path === null) {
    return;
  }
  const existing: SessionFileRef | undefined = map.get(path);
  if (existing === undefined) {
    map.set(path, new SessionFileRef(path, 1, seq));
  } else {
    map.set(path, new SessionFileRef(path, existing.count + 1,
      Math.max(existing.lastSeq, seq), existing.description));
  }
}

/** `data.meta.diffs[].path`（首选）或顶层 `data.diffs[].path`（旧版形态）。 */
function diffPaths(data: JsonMap): string[] {
  const meta: JsonMap | null = JsonAccess.obj(data, 'meta');
  let diffs: Object | null = null;
  if (meta !== null) {
    diffs = JsonAccess.raw(meta, 'diffs');
  }
  if (diffs === null) {
    diffs = JsonAccess.raw(data, 'diffs');
  }
  const out: string[] = [];
  const entries: Object[] = asArray(diffs);
  for (let i = 0; i < entries.length; i++) {
    const entry: JsonMap | null = JsonAccess.asMap(entries[i]);
    const path: string | null = refsStr(entry, 'path');
    if (path !== null) {
      out.push(path);
    }
  }
  return out;
}

/** `content[]` 里带 `arguments`/`input` 的块；工具名优先取块自己的，其次继承外层。 */
function contentBlocks(content: Object | null, fallbackName: string | null): ToolCandidate[] {
  const out: ToolCandidate[] = [];
  const entries: Object[] = asArray(content);
  for (let i = 0; i < entries.length; i++) {
    const value: JsonMap | null = JsonAccess.asMap(entries[i]);
    if (value === null) {
      continue;
    }
    const argumentsValue: Object | null = JsonAccess.raw(value, 'arguments');
    const inputValue: Object | null = argumentsValue === null ? JsonAccess.raw(value, 'input') : null;
    const resolvedArguments: Object | null = argumentsValue === null ? inputValue : argumentsValue;
    if (resolvedArguments === null) {
      continue;
    }
    const name: string | null = refsStr(value, 'name');
    const toolName: string | null = name === null ? refsStr(value, 'toolName') : name;
    out.push(new ToolCandidate(toolName === null ? fallbackName : toolName, resolvedArguments));
  }
  return out;
}

function filePath(name: string | null, argumentsValue: Object | null): string | null {
  const tool: string | null = name === null
    ? null : name.substring(name.lastIndexOf('/') + 1).toLowerCase();
  if (tool !== null && UNPARSED_TOOLS.has(tool)) {
    return null;
  }
  const args: JsonMap | null = asObject(argumentsValue);
  if (args === null) {
    return null;
  }
  const filePathValue: string | null = refsStr(args, 'file_path');
  if (filePathValue !== null) {
    return filePathValue;
  }
  if (tool !== null && FILE_PATH_TOOLS.has(tool)) {
    return refsStr(args, 'path');
  }
  return null;
}

/** 从三处已知的事件形态里刮出「工具名 + 参数」配对，再按工具名决定要不要取路径。 */
function argumentPaths(data: JsonMap): string[] {
  const outerName: string | null = refsStr(data, 'name');
  const outerToolName: string | null = outerName === null ? refsStr(data, 'toolName') : outerName;
  const resolvedOuter: string | null = outerToolName === null ? refsStr(data, 'tool') : outerToolName;

  const candidates: ToolCandidate[] = [];
  const directArguments: Object | null = JsonAccess.raw(data, 'arguments');
  if (directArguments !== null) {
    candidates.push(new ToolCandidate(resolvedOuter, directArguments));
  }

  const content: Object | null = JsonAccess.raw(data, 'content');
  const contentCandidates: ToolCandidate[] = contentBlocks(content, resolvedOuter);
  for (let i = 0; i < contentCandidates.length; i++) {
    candidates.push(contentCandidates[i]);
  }

  const message: JsonMap | null = JsonAccess.obj(data, 'message');
  if (message !== null) {
    const messageName: string | null = refsStr(message, 'name');
    const messageToolName: string | null = messageName === null ? refsStr(message, 'toolName') : messageName;
    const resolvedMessageName: string | null = messageToolName === null ? resolvedOuter : messageToolName;
    const messageArguments: Object | null = JsonAccess.raw(message, 'arguments');
    if (messageArguments !== null) {
      candidates.push(new ToolCandidate(resolvedMessageName, messageArguments));
    }
    const messageContentCandidates: ToolCandidate[] =
      contentBlocks(JsonAccess.raw(message, 'content'), resolvedMessageName);
    for (let i = 0; i < messageContentCandidates.length; i++) {
      candidates.push(messageContentCandidates[i]);
    }
  }

  const streamEntries: Object[] = asArray(JsonAccess.raw(data, 'stream'));
  for (let i = 0; i < streamEntries.length; i++) {
    const streamed: JsonMap | null = JsonAccess.asMap(streamEntries[i]);
    if (streamed === null) {
      continue;
    }
    const chunkObj: JsonMap | null = JsonAccess.obj(streamed, 'chunk');
    const chunk: JsonMap = chunkObj === null ? streamed : chunkObj;
    const blockObj: JsonMap | null = JsonAccess.obj(chunk, 'block');
    const block: JsonMap = blockObj === null ? chunk : blockObj;
    const blockName: string | null = refsStr(block, 'name');
    const blockToolName: string | null = blockName === null ? refsStr(block, 'toolName') : blockName;
    const chunkName: string | null = refsStr(chunk, 'name');
    const name: string | null = blockToolName !== null ? blockToolName
      : (chunkName !== null ? chunkName : resolvedOuter);
    const blockArguments: Object | null = JsonAccess.raw(block, 'arguments');
    const resolvedArguments: Object | null = blockArguments === null
      ? JsonAccess.raw(chunk, 'arguments') : blockArguments;
    if (resolvedArguments !== null) {
      candidates.push(new ToolCandidate(name, resolvedArguments));
    }
  }

  const out: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const path: string | null = filePath(candidates[i].name, candidates[i].argumentsValue);
    if (path !== null) {
      out.push(path);
    }
  }
  return out;
}

/**
 * 扫描 `events`，按**首次出现顺序**返回去重后的文件引用。
 *
 * 输入为整个会话历史（`HistoryEntry.event` 的 `seq` 用来标注最后出现位置）；
 * 事件形态不认识、参数不是合法 JSON、字段类型不对时一律跳过，绝不抛异常 ——
 * 会话历史里有大量与文件无关的事件，任何一个畸形事件都不该让整个面板失效。
 */
export function sessionFileRefs(events: HistoryEntry[]): SessionFileRef[] {
  const collected: Map<string, SessionFileRef> = new Map<string, SessionFileRef>();
  for (let i = 0; i < events.length; i++) {
    const data: JsonMap | null = JsonAccess.asMap(events[i].event.data);
    if (data === null) {
      continue;
    }
    const seq: number = events[i].event.seq;
    const fromDiffs: string[] = diffPaths(data);
    for (let j = 0; j < fromDiffs.length; j++) {
      record(collected, fromDiffs[j], seq);
    }
    const fromArguments: string[] = argumentPaths(data);
    for (let j = 0; j < fromArguments.length; j++) {
      record(collected, fromArguments[j], seq);
    }
  }
  return Array.from(collected.values());
}
