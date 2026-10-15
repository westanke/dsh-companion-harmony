import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatDisplayItem, ChatItemKind, ToolCallDetail, displayItemsOf, formatToolDuration,
  prettyToolArguments, toolActionsFor, toolDurationMs,
} from '../../entry/src/main/ets/core/ChatPresentation.ts';
import { ChatHistory, HistoryEntry, SessionEvent } from '../../entry/src/main/ets/core/Models.ts';
import { JsonAccess } from '../../entry/src/main/ets/core/JsonAccess.ts';

/**
 * 工具调用详情（trajectory）的取值规则 —— 移植自原工程 `ToolCallDetailTest.kt`。
 *
 * 为什么值得单测：这些字段全是**从真实会话事件里挖出来的**（105 份 session.v4.jsonl.zstd、
 * 19050 条 tool/result），而规则本身在界面上一眼看不出来 —— callId 藏在
 * `data.message.toolCallId`、耗时是两件事件的 time 相减、合并成一组后每条都得留下明细。
 * 真机上错了只会表现为「展开后是空的」或「只剩第一条」，很难当场看出是哪一步错了。
 */

function entry(type: string, seq: number, time: number, dataJson: string): HistoryEntry {
  const row: HistoryEntry = new HistoryEntry();
  const event: SessionEvent = new SessionEvent();
  event.type = type;
  event.seq = seq;
  event.time = time;
  event.data = JsonAccess.parse(dataJson);
  row.event = event;
  return row;
}

function history(events: HistoryEntry[]): ChatHistory {
  const value: ChatHistory = new ChatHistory();
  value.events = events;
  value.hasMore = false;
  return value;
}

function onlyTool(historyValue: ChatHistory): ToolCallDetail {
  const items: ChatDisplayItem[] = displayItemsOf(historyValue);
  assert.equal(items.length, 1);
  assert.equal(items[0].tools.length, 1);
  return items[0].tools[0];
}

test('按 toolCallId 配上结果并算出耗时', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000,
      '{"turn":1,"step":7,"callId":"call_1","name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}'),
    entry('tool/result', 6, 1140,
      '{"turn":1,"step":7,"message":{"role":"tool","source":{"kind":"tool","callId":"call_1"},'
        + '"toolCallId":"call_1","content":[{"type":"text","text":"列出了 3 个文件"}],'
        + '"isError":false,"id":"m1"}}'),
  ]);

  const tool: ToolCallDetail = onlyTool(value);
  assert.equal(tool.callId, 'call_1');
  assert.equal(tool.name, 'bash');
  assert.equal(tool.argumentsJson, '{"command":"ls"}');
  assert.equal(tool.result, '列出了 3 个文件');
  assert.equal(tool.failed, false);
  assert.equal(tool.durationMs, 140);
});

test('message 里没有 toolCallId 时退回 source.callId', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"call_9","name":"read","arguments":"{}"}'),
    entry('tool/result', 6, 1050,
      '{"message":{"source":{"kind":"tool","callId":"call_9"},'
        + '"content":[{"type":"text","text":"正文"}],"isError":false}}'),
  ]);

  const tool: ToolCallDetail = onlyTool(value);
  assert.equal(tool.callId, 'call_9');
  assert.equal(tool.result, '正文');
  assert.equal(tool.durationMs, 50);
});

test('两个关联字段都拿不到的结果直接跳过，宁可不显示也不猜', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"call_1","name":"bash","arguments":"{}"}'),
    entry('tool/result', 6, 1200,
      '{"message":{"content":[{"type":"text","text":"无处可归"}]}}'),
  ]);

  const tool: ToolCallDetail = onlyTool(value);
  assert.equal(tool.result, null);
  assert.equal(tool.durationMs, null);
});

test('还在跑的调用（有 call 没 result）：既不显示结果也不显示耗时', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"call_1","name":"bash","arguments":"{}"}'),
  ]);

  const tool: ToolCallDetail = onlyTool(value);
  assert.equal(tool.result, null);
  assert.equal(tool.durationMs, null);
});

test('合并成一组后，每一次调用的明细一条都不能丢，且保持顺序', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"a","name":"bash","arguments":"{\\"command\\":\\"one\\"}"}'),
    entry('tool/result', 6, 1100,
      '{"message":{"toolCallId":"a","content":[{"type":"text","text":"one ok"}],"isError":false}}'),
    entry('tool/call', 7, 2000, '{"callId":"b","name":"read","arguments":"{}"}'),
    entry('tool/result', 8, 2250,
      '{"message":{"toolCallId":"b","content":[{"type":"text","text":"b ok"}],"isError":false}}'),
    entry('tool/call', 9, 3000, '{"callId":"c","name":"bash","arguments":"{\\"command\\":\\"three\\"}"}'),
    entry('tool/result', 10, 3500,
      '{"message":{"toolCallId":"c","content":[{"type":"text","text":"Error: boom"}],"isError":true}}'),
  ]);

  const items: ChatDisplayItem[] = displayItemsOf(value);
  assert.equal(items.length, 1);
  const merged: ChatDisplayItem = items[0];
  assert.equal(merged.kind, ChatItemKind.TOOL);

  assert.deepEqual(merged.tools.map((it) => it.callId), ['a', 'b', 'c']);
  assert.deepEqual(merged.tools.map((it) => it.name), ['bash', 'read', 'bash']);
  assert.deepEqual(merged.tools.map((it) => it.result), ['one ok', 'b ok', 'Error: boom']);
  assert.deepEqual(merged.tools.map((it) => it.durationMs), [100, 250, 500]);
  assert.deepEqual(merged.tools.map((it) => it.failed), [false, false, true]);
  // 合并行本身的 id 覆盖首末 seq，供界面做稳定的列表 key。
  assert.equal(merged.id, 'tools-5-9');
});

test('标记失败并保留内核写的那句错误原文', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"t","name":"web_fetch","arguments":"{}"}'),
    entry('tool/result', 6, 1010,
      '{"message":{"toolCallId":"t","content":[{"type":"text","text":"Error: Request timed out"}],'
        + '"isError":true}}'),
  ]);

  const tool: ToolCallDetail = onlyTool(value);
  assert.equal(tool.failed, true);
  assert.equal(tool.result, 'Error: Request timed out');
});

test('结果里的 text 段用空行相接，图片段写成一行占位', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"i","name":"screenshot","arguments":"{}"}'),
    entry('tool/result', 6, 1400,
      '{"message":{"toolCallId":"i","content":[' 
        + '{"type":"text","text":"第一段"},'
        + '{"type":"image","attachment":{"attachmentId":"sha256:abc","mediaType":"image/png",'
        + '"bytes":2456,"width":320,"height":320,"name":"github.png"}},'
        + '{"type":"text","text":"第二段"}],"isError":false}}'),
  ]);

  const result: string | null = onlyTool(value).result;
  assert.notEqual(result, null);
  assert.ok(result!.indexOf('第一段') >= 0);
  assert.ok(result!.indexOf('第二段') >= 0);
  assert.ok(result!.indexOf('[image github.png 320×320]') >= 0);
});

test('空结果与「还没有结果」是两回事', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"e","name":"bash","arguments":"{}"}'),
    entry('tool/result', 6, 1100, '{"message":{"toolCallId":"e","content":[],"isError":false}}'),
  ]);

  const tool: ToolCallDetail = onlyTool(value);
  assert.equal(tool.result, '');
  assert.equal(tool.durationMs, 100);
});

test('耗时不可信时干脆不显示', () => {
  assert.equal(toolDurationMs(1000, null), null);
  // 时钟倒退（休眠恢复 / NTP 校时）—— 实测日志里有一条 bash 差 9821 秒，那不是执行时间。
  assert.equal(toolDurationMs(1000, 900), null);
  assert.equal(toolDurationMs(1000, 1000), 0);
  assert.equal(toolDurationMs(1000, 1500), 500);
});

test('耗时那几个档位的边界都对', () => {
  assert.equal(formatToolDuration(0), '0 ms');
  assert.equal(formatToolDuration(999), '999 ms');
  assert.equal(formatToolDuration(1000), '1.0 s');
  assert.equal(formatToolDuration(1500), '1.5 s');
  assert.equal(formatToolDuration(60000), '1m 0s');
  assert.equal(formatToolDuration(123000), '2m 3s');
  assert.equal(formatToolDuration(3600000), '1h 0m');
  // 实测最大的一条（167336332 ms）也落在这一档里，不会溢出成怪值。
  assert.equal(formatToolDuration(167336332), '46h 28m');
});

test('arguments 缩进成可读 JSON；坏 JSON 原样返回；空白算没有参数', () => {
  const pretty: string = prettyToolArguments('{"command":"ls -la","description":"列目录"}');
  assert.ok(pretty.indexOf('\n') >= 0);
  assert.ok(pretty.indexOf('"command"') >= 0);
  assert.ok(pretty.indexOf('ls -la') >= 0);

  // 坏 JSON 原样返回：宁可给一坨原始文本，也不要把参数藏起来。
  assert.equal(prettyToolArguments('{raw protocol payload'), '{raw protocol payload');
  assert.equal(prettyToolArguments('   '), '');
});

test('动作短语：按工具名给，认不出就用工具自己的名字', () => {
  assert.deepEqual(toolActionsFor('bash', null), ['执行了命令']);
  assert.deepEqual(toolActionsFor('pwsh', null), ['执行了命令']);
  assert.deepEqual(toolActionsFor('read', null), ['读取了文件']);
  assert.deepEqual(toolActionsFor('write', null), ['已写入文件']);
  assert.deepEqual(toolActionsFor('edit', null), ['修改了文件']);
  assert.deepEqual(toolActionsFor('grep', null), ['搜索了内容']);
  assert.deepEqual(toolActionsFor('glob', null), ['搜索了文件']);
  assert.deepEqual(toolActionsFor('web_fetch', null), ['已访问网页']);
  assert.deepEqual(toolActionsFor('web_search', null), ['已搜索网页']);
  assert.deepEqual(toolActionsFor('mystery', null), ['mystery']);
  assert.deepEqual(toolActionsFor('', null), ['工具']);
});

test('run_code：按参数里出现的内层工具补出动作，顺序与官方措辞一致', () => {
  // 真实数据：run_code 的 arguments 里 "tools.bash" 出现 748 次、tools.edit 158、
  // tools.read 116、tools.write 53；bash + write 这一组合 42 例，对应的正是官方那句
  // 「运行了代码，已写入文件，执行了命令」—— 所以扫参数是**结论**，不是猜测。
  const args: string = '{"tools.bash":"ls","tools.write":"a.txt"}';
  assert.deepEqual(toolActionsFor('run_code', args), ['运行了代码', '已写入文件', '执行了命令']);

  // edit 先于 write（官方是「修改了文件，已写入文件」）。
  const editAndWrite: string = '{"tools.edit":"x","tools.write":"y"}';
  assert.deepEqual(toolActionsFor('run_code', editAndWrite), ['运行了代码', '修改了文件', '已写入文件']);

  // 没有内层工具时只有「运行了代码」。
  assert.deepEqual(toolActionsFor('run_code', '{}'), ['运行了代码']);
  assert.deepEqual(toolActionsFor('run_code', null), ['运行了代码']);
});

test('MCP 工具名翻成人话（写在外层的名字不原样抛给用户）', () => {
  assert.deepEqual(toolActionsFor('mcp__filesystem__read_file', null), ['调用了 filesystem · read_file']);
  assert.deepEqual(toolActionsFor('mcp__a__b__c', null), ['调用了 a · b · c']);
});

test('正文优先取 view.description，其次参数摘要，再次 view.title，最后工具名', () => {
  const withDescription: HistoryEntry = new HistoryEntry();
  withDescription.event.type = 'tool/call';
  withDescription.event.seq = 5;
  withDescription.event.time = 1000;
  withDescription.event.data = JsonAccess.parse(
    '{"callId":"c","name":"bash","arguments":"{\\"command\\":\\"ls\\",\\"description\\":\\"参数里的说明\\"}"}');
  withDescription.view = JsonAccess.parse('{"view":{"title":"标题","description":"视图说明"}}');
  assert.equal(displayItemsOf(history([withDescription]))[0].body, '视图说明');

  const summary: HistoryEntry = new HistoryEntry();
  summary.event.type = 'tool/call';
  summary.event.seq = 6;
  summary.event.time = 1000;
  summary.event.data = JsonAccess.parse(
    '{"callId":"c","name":"read","arguments":"{\\"path\\":\\"/w/a.ts\\"}"}');
  summary.view = JsonAccess.parse('{"view":{"title":"只有标题"}}');
  // 参数摘要是**第一行**（路径这类值理论上可能带换行）。
  assert.equal(displayItemsOf(history([summary]))[0].body, '/w/a.ts');

  const titleOnly: HistoryEntry = new HistoryEntry();
  titleOnly.event.type = 'tool/call';
  titleOnly.event.seq = 7;
  titleOnly.event.time = 1000;
  titleOnly.event.data = JsonAccess.parse('{"callId":"c","name":"noop","arguments":"{}"}');
  titleOnly.view = JsonAccess.parse('{"view":{"title":"只有标题"}}');
  assert.equal(displayItemsOf(history([titleOnly]))[0].body, '只有标题');

  const nameOnly: HistoryEntry = new HistoryEntry();
  nameOnly.event.type = 'tool/call';
  nameOnly.event.seq = 8;
  nameOnly.event.time = 1000;
  nameOnly.event.data = JsonAccess.parse('{"callId":"c","name":"noop","arguments":"{}"}');
  assert.equal(displayItemsOf(history([nameOnly]))[0].body, 'noop');
});

test('夹着正文的两段工具调用不会被合并成一组', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"a","name":"bash","arguments":"{}"}'),
    entry('assistant/message', 6, 1500,
      '{"message":{"content":[{"type":"text","text":"中间说了句话"}]}}'),
    entry('tool/call', 7, 2000, '{"callId":"b","name":"read","arguments":"{}"}'),
  ]);

  const items: ChatDisplayItem[] = displayItemsOf(value);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((it) => it.kind),
    [ChatItemKind.TOOL, ChatItemKind.ASSISTANT, ChatItemKind.TOOL]);
});

test('单条工具调用不合并，动作短语直接当标题', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, 1000, '{"callId":"a","name":"bash","arguments":"{}"}'),
  ]);

  const items: ChatDisplayItem[] = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '执行了命令');
  assert.deepEqual(items[0].actions, ['执行了命令']);
});

test('动作短语超过 4 种时收尾加「等」', () => {
  const events: HistoryEntry[] = [];
  const names: string[] = ['bash', 'read', 'write', 'edit', 'grep', 'glob'];
  for (let i = 0; i < names.length; i++) {
    events.push(entry('tool/call', 5 + i, 1000 + i * 100,
      `{"callId":"c${i}","name":"${names[i]}","arguments":"{}"}`));
  }

  const items: ChatDisplayItem[] = displayItemsOf(history(events));
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'tools-5-10');
  assert.equal(items[0].actions.length, 6);
  // 前 4 种 + 「等」。
  assert.equal(items[0].title, '执行了命令，读取了文件，已写入文件，修改了文件等');
});
