/**
 * 聊天页呈现模型 —— **第五层：工具条目**（从 `ChatPresentation.ts` 拆出）。
 *
 * 工具调用的显示项构造（`toolItem`）、连续调用的合并（`mergeToolRuns`）、
 * 以及工具输入/输出的取值（`contentText` / `contentTextParts` / `contextLabel`）。
 *
 * 合并的依据与源工程一致：相邻的、同一批的调用合成一行，展开才看得到明细。
 *
 * 拆分来龙去脉见 `ChatPresentation.ts` 文件头。
 */

import { HistoryEntry, SessionEvent } from './Models';
import { JsonAccess, JsonMap } from './JsonAccess';
import { isNotBlank } from './TextPredicates';
import { ChatDisplayItem, ChatItemKind, ToolCallDetail } from './ChatPresentationTypes';
import { ChatJson } from './ChatJson';
import { argumentsSummary, ToolResultInfo, toolActionsFor, toolDurationMs } from './ChatToolFormat';

export function toolItem(entry: HistoryEntry, toolResults: Map<string, ToolResultInfo>): ChatDisplayItem {
  const event: SessionEvent = entry.event;
  const data: JsonMap | null = event.dataMap();
  const name: string | null = ChatJson.str(data, 'name');
  const view: JsonMap | null = ChatJson.obj(JsonAccess.asMap(entry.view), 'view');
  const viewTitle: string | null = ChatJson.str(view, 'title');
  const description: string | null = ChatJson.str(view, 'description');
  const argumentsRaw: string | null = ChatJson.str(data, 'arguments');
  const actions: string[] = toolActionsFor(name === null ? '' : name, argumentsRaw);
  const callId: string | null = ChatJson.str(data, 'callId');
  const resolvedCallId: string = callId === null ? '' : callId;
  const result: ToolResultInfo | undefined = toolResults.get(resolvedCallId);

  // 正文优先级：view.description > arguments 摘要 > view.title > 工具名。
  let body: string = description === null ? '' : description;
  if (description === null) {
    const summary: string | null = argumentsSummary(argumentsRaw);
    if (summary !== null) {
      body = summary;
    } else if (viewTitle !== null) {
      body = viewTitle;
    } else {
      body = name === null ? '' : name;
    }
  }

  const detail: ToolCallDetail = new ToolCallDetail(
    resolvedCallId,
    name === null ? '' : name,
    argumentsRaw === null ? '' : argumentsRaw,
    result === undefined ? null : result.text,
    result !== undefined && result.failed,
    toolDurationMs(event.time, result === undefined ? null : result.time),
  );

  return new ChatDisplayItem(
    `${event.seq}-tool`,
    event.seq,
    ChatItemKind.TOOL,
    // 标题就是动作短语（官方口径），不再是 "Code" / "Read" 这种英文类别词。
    actions.join('，'),
    body,
    false,
    [],
    actions,
    [detail],
    null,
    event.time,
  );
}

/**
 * 把**连续**的工具调用合并成一项，标题报动作摘要。
 *
 * 与 WebView 页的 `toolGroupSummary` 同一口径：各条短语按首次出现顺序去重求并集，
 * 超过 4 条收尾加「等」。原生原先是一次调用一行，一跑几十次就是一屏行；网页版是一组一行。
 *
 * 只合并**相邻**的 TOOL —— 中间夹了正文就断开，那说明确实是两段工作。
 */
export function mergeToolRuns(items: ChatDisplayItem[]): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = [];
  let run: ChatDisplayItem[] = [];

  const flush = (): void => {
    if (run.length === 0) {
      return;
    }
    if (run.length === 1) {
      out.push(run[0]);
      run = [];
      return;
    }
    const actions: string[] = [];
    for (let i = 0; i < run.length; i++) {
      const item: ChatDisplayItem = run[i];
      for (let k = 0; k < item.actions.length; k++) {
        if (actions.indexOf(item.actions[k]) < 0) {
          actions.push(item.actions[k]);
        }
      }
    }
    let title: string;
    if (actions.length === 0) {
      title = `${run.length} 次工具调用`;
    } else if (actions.length > 4) {
      title = `${actions.slice(0, 4).join('，')}等`;
    } else {
      title = actions.join('，');
    }

    const bodies: string[] = [];
    const tools: ToolCallDetail[] = [];
    for (let i = 0; i < run.length; i++) {
      bodies.push(run[i].body);
      for (let k = 0; k < run[i].tools.length; k++) {
        tools.push(run[i].tools[k]);
      }
    }
    out.push(run[0].withMerged(
      `tools-${run[0].seq}-${run[run.length - 1].seq}`,
      title,
      bodies.join('\n'),
      actions,
      // 合并的是**显示**，不是数据：每一调的明细都要留着，
      // 详情视图才能逐条展开（只留第一条 = 其余调用的输出全丢）。
      tools,
    ));
    run = [];
  };

  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === ChatItemKind.TOOL) {
      run.push(items[i]);
    } else {
      flush();
      out.push(items[i]);
    }
  }
  flush();
  return out;
}

export function contentText(content: Object | null): string {
  const parts: string[] = contentTextParts(content);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (isNotBlank(parts[i])) {
      kept.push(parts[i]);
    }
  }
  return kept.join('\n\n');
}

/**
 * 把 content 拆成逐条文本。
 *
 * 与 [contentText] 的区别是**不合并**：交接说明必须能被整条摘掉，
 * 合并之后再按行切割就成了「拿分隔符当数据结构」。
 */
export function contentTextParts(content: Object | null): string[] {
  if (content === null || content === undefined) {
    return [];
  }
  if (typeof content === 'string') {
    return [content as string];
  }
  if (typeof content === 'number') {
    return [`${content as number}`];
  }
  if (typeof content === 'boolean') {
    return [(content as boolean) ? 'true' : 'false'];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: Object[] = content as Object[];
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const value: JsonMap | null = JsonAccess.asMap(blocks[i]);
    if (value === null) {
      continue;
    }
    const type: string | null = ChatJson.str(value, 'type');
    if (type === 'text' || type === 'reasoning') {
      const text: string | null = ChatJson.str(value, 'text');
      if (text !== null) {
        out.push(text);
      }
    }
  }
  return out;
}

export function contextLabel(source: JsonMap | null): string | null {
  if (source === null) {
    return null;
  }
  const kind: string | null = ChatJson.str(source, 'kind');
  if (kind === 'agent-instructions') {
    const labels: string = ChatJson.arrayLabels(source, 'changes', 'path');
    return labels.length === 0 ? null : labels;
  }
  if (kind === 'session-reference') {
    const labels: string = ChatJson.arrayLabels(source, 'references', 'label');
    return labels.length === 0 ? null : labels;
  }
  if (kind === 'plugin') {
    const plugin: string | null = ChatJson.str(source, 'plugin');
    return plugin === null ? kind : plugin;
  }
  if (kind === 'skill-invocation') {
    const name: string | null = ChatJson.str(source, 'name');
    return name === null ? kind : name;
  }
  return kind;
}
