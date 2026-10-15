/**
 * 聊天页呈现模型 —— **第六层：工具信息的取值与措辞**（从 `ChatPresentation.ts` 拆出）。
 *
 * 工具结果的结构化取值（`ToolResultInfo` / `toolResultsByCallId` / `toolResultText`）、
 * 耗时（`toolDurationMs` / `formatToolDuration`）与参数摘要（`argumentsSummary`）、
 * 以及**动作短语**（`toolActionsFor`，措辞与判定方式照官方 Web 界面还原）。
 *
 * 拆分来龙去脉见 `ChatPresentation.ts` 文件头。
 */

import { HistoryEntry, SessionEvent } from './Models';
import { JsonAccess, JsonMap } from './JsonAccess';
import { isBlank, isNotBlank } from './TextPredicates';
import { ChatJson, firstLine } from './ChatJson';

/** 一条 `tool/result` 的可用信息（内部结构，只在这个文件里流转）。 */
export class ToolResultInfo {
  text: string;
  failed: boolean;
  time: number;

  constructor(text: string, failed: boolean, time: number) {
    this.text = text;
    this.failed = failed;
    this.time = time;
  }
}

/**
 * 一个工具调用的**动作短语**，如 `['运行了代码', '已写入文件', '执行了命令']`。
 *
 * 措辞与判定方式都照官方 Web 界面还原（`@deepseek-ai/dsh-client-ui-chat`）：
 * 那边是内核给一个 `summary.counts[{kind}]`，按 kind 取 i18n 文案再拼；
 * 我们的会话事件里**没有**这个结构化字段（`tool/call` 无 view/description、
 * `tool/result` 无 meta，已逐条核实），所以只能按工具名与参数近似还原。
 *
 * `run_code` 的处理来自真实数据统计：1129 次调用的 arguments 里，
 * `tools.bash` 748 次、`tools.edit` 158、`tools.read` 116、`tools.write` 53；
 * 其中 `bash` + `write` 这一组合 42 例，对应的正是官方那句
 * 「运行了代码，已写入文件，执行了命令」—— 所以扫参数是**结论**，不是猜测。
 *
 * 顺序按官方措辞对齐：edit 先于 write（官方是「修改了文件，已写入文件」）。
 */
export const INNER_ACTIONS: string[][] = [
  ['tools.edit', '修改了文件'],
  ['tools.write', '已写入文件'],
  ['tools.read', '读取了文件'],
  ['tools.bash', '执行了命令'],
  ['tools.grep', '搜索了内容'],
  ['tools.glob', '搜索了文件'],
];

export const ACTIONS_BY_NAME: Map<string, string> = new Map<string, string>([
  ['bash', '执行了命令'],
  ['pwsh', '执行了命令'],
  ['read', '读取了文件'],
  ['write', '已写入文件'],
  ['edit', '修改了文件'],
  ['grep', '搜索了内容'],
  ['glob', '搜索了文件'],
  ['web_fetch', '已访问网页'],
  ['web_search', '已搜索网页'],
]);

export function toolActionsFor(name: string, argumentsRaw: string | null): string[] {
  const raw: string = argumentsRaw === null ? '' : argumentsRaw;
  if (name === 'run_code') {
    const out: string[] = ['运行了代码'];
    for (let i = 0; i < INNER_ACTIONS.length; i++) {
      const needle: string = INNER_ACTIONS[i][0];
      const phrase: string = INNER_ACTIONS[i][1];
      if (raw.indexOf(needle) >= 0 && out.indexOf(phrase) < 0) {
        out.push(phrase);
      }
    }
    return out;
  }
  const byName: string | undefined = ACTIONS_BY_NAME.get(name);
  if (byName !== undefined) {
    return [byName];
  }
  if (name.startsWith('mcp__')) {
    return [`调用了 ${name.substring(5).split('__').join(' · ')}`];
  }
  return [isNotBlank(name) ? name : '工具'];
}

/** arguments 里最像"一句话说明"的那个字段，取它的第一行。 */
export const ARGUMENT_SUMMARY_KEYS: string[] = [
  'description', 'path', 'file_path', 'query', 'pattern', 'url', 'command', 'name', 'package',
];

export function argumentsSummary(raw: string | null): string | null {
  if (raw === null || isBlank(raw)) {
    return null;
  }
  const parsed: JsonMap | null = JsonAccess.asMap(JsonAccess.parse(raw));
  if (parsed === null) {
    return null;
  }
  for (let i = 0; i < ARGUMENT_SUMMARY_KEYS.length; i++) {
    const key: string = ARGUMENT_SUMMARY_KEYS[i];
    const value: string | null = ChatJson.str(parsed, key);
    if (value !== null && isNotBlank(value)) {
      return firstLine(value);
    }
  }
  return null;
}

/**
 * 把 `tool/result` 按 callId 建索引。
 *
 * 关联字段优先用 `data.message.toolCallId`，退路是 `data.message.source.callId`：
 * 实测两者在 8006/8006 条里完全相等，但只认一个的话，内核哪天只留另一个就全配不上了。
 * 两个都拿不到的行直接跳过（宁可不显示，也不猜）。
 */
export function toolResultsByCallId(events: HistoryEntry[]): Map<string, ToolResultInfo> {
  const out: Map<string, ToolResultInfo> = new Map();
  for (let i = 0; i < events.length; i++) {
    const event: SessionEvent = events[i].event;
    if (event.type !== 'tool/result') {
      continue;
    }
    const data: JsonMap | null = event.dataMap();
    if (data === null) {
      continue;
    }
    const message: JsonMap | null = ChatJson.obj(data, 'message');
    if (message === null) {
      continue;
    }
    let callId: string | null = ChatJson.str(message, 'toolCallId');
    if (callId === null) {
      callId = ChatJson.str(ChatJson.obj(message, 'source'), 'callId');
    }
    if (callId === null) {
      continue;
    }
    out.set(callId, new ToolResultInfo(toolResultText(message),
      ChatJson.bool(message, 'isError') === true, event.time));
  }
  return out;
}

/**
 * 一个工具结果的正文。
 *
 * 内核的 `message.content` 实测**一定是数组**（19050/19050），元素只有两种：
 * `text`（取 text）与 `image`（只有附件引用，字节在服务端附件存储里）。
 * 图片这里用一行占位写出来，而不是静默丢掉 —— 「这里本来有一张图」也是信息。
 *
 * 空段丢掉、段间空行，与网页版 `partsText(content, 'text')` 同一口径。
 */
export function toolResultText(message: JsonMap): string {
  const content: Object | null = JsonAccess.raw(message, 'content');
  if (content === null) {
    return '';
  }
  if (!Array.isArray(content)) {
    const primitive: string | null = ChatJson.str(message, 'content');
    return primitive === null ? '' : primitive;
  }
  const parts: Object[] = content as Object[];
  const text: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part: JsonMap | null = JsonAccess.asMap(parts[i]);
    if (part === null) {
      continue;
    }
    const type: string | null = ChatJson.str(part, 'type');
    if (type === 'text') {
      const value: string | null = ChatJson.str(part, 'text');
      if (value !== null) {
        text.push(value);
      }
    } else if (type === 'image') {
      const attachment: JsonMap | null = ChatJson.obj(part, 'attachment');
      let name: string | null = ChatJson.str(attachment, 'name');
      if (name === null || isBlank(name)) {
        name = 'attachment';
      }
      const width: number = ChatJson.int(attachment, 'width') ?? 0;
      const height: number = ChatJson.int(attachment, 'height') ?? 0;
      if (width > 0 && height > 0) {
        text.push(`[image ${name} ${width}×${height}]`);
      } else {
        text.push(`[image ${name}]`);
      }
    }
  }
  const kept: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (isNotBlank(text[i])) {
      kept.push(text[i]);
    }
  }
  return kept.join('\n\n');
}

/**
 * 耗时 = `tool/result.time - tool/call.time`（都是 epoch 毫秒）。
 *
 * 结果为负说明时钟倒退（机器休眠恢复、NTP 校时 —— 实测日志里有一条 bash 差 9821 秒，
 * 那是挂起时间不是执行时间）。这种情况**不显示**，而不是显示一个负数或 0：
 * 宁可少一行，也不要瞎编。
 */
export function toolDurationMs(callTime: number, resultTime: number | null): number | null {
  if (resultTime === null) {
    return null;
  }
  const delta: number = resultTime - callTime;
  return delta < 0 ? null : delta;
}

/**
 * 耗时的人类可读格式。
 *
 * 刻意**不进字符串资源**：ms / s / m / h 是通用单位，翻成「毫秒/秒/分」只会更长、
 * 并不会更好读；而这一行本来就是元数据。边界都在单测里钉住。
 */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60000) {
    return `${oneDecimal(ms / 1000)} s`;
  }
  if (ms < 3600000) {
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/** 对应 Kotlin `"%.1f"`（HALF_UP）：只保留一位小数，且不带千分位/科学计数。 */
export function oneDecimal(value: number): string {
  const tenths: number = Math.round(value * 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/**
 * 把内核给的 arguments 格式化成可读 JSON。
 *
 * `arguments` 是**字符串**（实测 12471/12471 可解析），塞进界面之前要缩进；
 * 但解析失败就原样返回 —— 宁可给一坨原始文本，也不要把参数藏起来
 * （真机上曾经因为「坏 JSON 一律丢弃」而让整条调用看起来没有输入）。
 *
 * 缩进宽度取 kotlinx `prettyPrint` 的 4 空格口径。
 */
export function prettyToolArguments(raw: string): string {
  if (isBlank(raw)) {
    return '';
  }
  const parsed: Object | null = JsonAccess.parse(raw);
  if (parsed === null) {
    return raw;
  }
  try {
    return JSON.stringify(parsed, null, 4);
  } catch (e) {
    return raw;
  }
}
