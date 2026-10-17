import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatItemKind, ChatDisplayItem, ChatTurnFailure, ToolCallDetail,
} from '../../entry/src/main/ets/core/ChatPresentationTypes.ts';
import {
  ChatDisplayEntry, ChatDisplayEntryKind, ProcessGroupSummary, chatDisplayEntryKey,
  formatProcessSpan, groupChatDisplay,
} from '../../entry/src/main/ets/core/ChatDisplayGroups.ts';

/**
 * 会话显示分组的两件事：**二分边界**与**摘要措辞** —— 逐条对应原工程
 * `ChatDisplayGroupsTest.kt`（本轮移植）。
 *
 * 为什么值得单测：分组错了不会崩，只会表现为「有一段话不见了」或者「一组干的事被劈成两组」——
 * 真机上极难当场归因（页面只是看起来少了一行）。摘要措辞同理：单位换算差一档，
 * 用户看到的是「耗时 0 秒」，看起来像功能坏了。
 *
 * 最要紧的一条是 `flatteningEveryGroupingReproducesTheInputExactly`：**分组不许丢项**。
 * 它是**穷举**断言（6 种 kind、长度 1..4 共 1554 条序列），因为分区函数的 bug
 * 恰恰只在某些相邻组合上露头，挑几个例子是挑不出来的。
 *
 * 数据层是纯函数：不读系统时间，时间只从入参（`groupChatDisplay` 的 `timeOf`）取，
 * 所以下面每一条断言都是确定的。
 *
 * ### 与 Kotlin 版本唯一的语言差异
 *
 * 源工程的时间是 `Long?`（`null` = 没有时间），本工程统一用 **`0`** 表示「没有时间」
 * （与 `ChatDisplayItem.time` 同一约定，见 `core/ChatPresentationTypes.ts`）。
 * 所以下面凡是用 `null` 比时间的地方都换成 `0`，`durationMs()` 的「不可信跨度」
 * 也从 `null` 变成 `0`。语义不变。
 */

/** 造一条展示项：id 形如 `"3-user"`，序号从 id 里取，方便回看顺序有没有乱。 */
function item(kind: ChatItemKind, id: string, tools: ToolCallDetail[] = []): ChatDisplayItem {
  const head: string = id.includes('-') ? id.substring(0, id.indexOf('-')) : id;
  const seq: number = Number.parseInt(head, 10);
  return new ChatDisplayItem(id, Number.isNaN(seq) ? 0 : seq, kind, null, '', false, [], [], tools);
}

function tool(callId: string): ToolCallDetail {
  return new ToolCallDetail(callId, 'bash', '{}');
}

/** 把分组结果摊平回一串 item —— 属性断言靠它。 */
function flatten(entries: ChatDisplayEntry[]): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry: ChatDisplayEntry = entries[i];
    if (entry.kind === ChatDisplayEntryKind.MESSAGE) {
      if (entry.item !== null) {
        out.push(entry.item);
      }
    } else {
      for (let j = 0; j < entry.items.length; j++) {
        out.push(entry.items[j]);
      }
    }
  }
  return out;
}

function groupsOf(entries: ChatDisplayEntry[]): ChatDisplayEntry[] {
  return entries.filter((entry: ChatDisplayEntry): boolean =>
    entry.kind === ChatDisplayEntryKind.PROCESS_GROUP);
}

function messagesOf(entries: ChatDisplayEntry[]): ChatDisplayItem[] {
  const out: ChatDisplayItem[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry: ChatDisplayEntry = entries[i];
    if (entry.kind === ChatDisplayEntryKind.MESSAGE && entry.item !== null) {
      out.push(entry.item);
    }
  }
  return out;
}

function idsOf(items: ChatDisplayItem[]): string[] {
  return items.map((entry: ChatDisplayItem): string => entry.id);
}

/** 组内的条目 id 列表。 */
function groupItemIds(group: ChatDisplayEntry): string[] {
  return idsOf(group.items);
}

// ── 二分边界 ──

test('空输入产不出任何条目', () => {
  assert.equal(groupChatDisplay([]).length, 0);
});

test('单条消息原样保留', () => {
  const user: ChatDisplayItem = item(ChatItemKind.USER, '1-user');

  const entries: ChatDisplayEntry[] = groupChatDisplay([user]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, ChatDisplayEntryKind.MESSAGE);
  assert.equal(entries[0].item, user);
});

test('三条连续的过程项收成一组', () => {
  const items: ChatDisplayItem[] = [
    item(ChatItemKind.CONTEXT, '1-context'),
    item(ChatItemKind.TOOL, '2-tool', [tool('a')]),
    item(ChatItemKind.TOOL, '3-tool', [tool('b')]),
  ];

  const entries: ChatDisplayEntry[] = groupChatDisplay(items);

  assert.equal(entries.length, 1);
  const group: ChatDisplayEntry = entries[0];
  assert.equal(group.kind, ChatDisplayEntryKind.PROCESS_GROUP);
  assert.deepEqual(group.items, items);
  assert.equal(group.items.length, 3);
  assert.equal(group.summary?.toolCalls, 2);
  assert.equal(group.summary?.contextItems, 1);
});

test('消息-过程-消息 保持三条且在原位', () => {
  const user: ChatDisplayItem = item(ChatItemKind.USER, '1-user');
  const reasoning: ChatDisplayItem = item(ChatItemKind.REASONING, '2-reasoning');
  const assistant: ChatDisplayItem = item(ChatItemKind.ASSISTANT, '3-assistant');

  const entries: ChatDisplayEntry[] = groupChatDisplay([user, reasoning, assistant]);

  assert.equal(entries.length, 3);
  assert.equal(entries[0].item, user);
  assert.equal(entries[1].kind, ChatDisplayEntryKind.PROCESS_GROUP);
  assert.deepEqual(groupItemIds(groupsOf(entries)[0]), [reasoning.id]);
  assert.equal(entries[2].item, assistant);
});

test('首尾两组都能 flush（末尾那组靠收尾 flush 才出现）', () => {
  const entries: ChatDisplayEntry[] = groupChatDisplay([
    item(ChatItemKind.CONTEXT, '1-context'),
    item(ChatItemKind.REASONING, '2-reasoning'),
    item(ChatItemKind.USER, '3-user'),
    item(ChatItemKind.TOOL, '4-tool'),
    item(ChatItemKind.TOOL, '5-tool'),
  ]);

  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, ChatDisplayEntryKind.PROCESS_GROUP);
  assert.equal(entries[2].kind, ChatDisplayEntryKind.PROCESS_GROUP);
  assert.deepEqual(groupItemIds(groupsOf(entries)[0]), ['1-context', '2-reasoning']);
  assert.deepEqual(groupItemIds(groupsOf(entries)[1]), ['4-tool', '5-tool']);
  assert.deepEqual(idsOf(messagesOf(entries)), ['3-user']);
});

test('只有 1 项的过程项也照样产组', () => {
  // 只有 1 项也照样产组：折不折、展不展是 UI 的判断，数据层不做这个决定
  //（做了的话 UI 就没有「这一项其实是一组」的信息了）。
  const entries: ChatDisplayEntry[] = groupChatDisplay([item(ChatItemKind.CONTEXT, '1-context')]);

  assert.equal(entries.length, 1);
  const group: ChatDisplayEntry = entries[0];
  assert.equal(group.kind, ChatDisplayEntryKind.PROCESS_GROUP);
  assert.equal(group.items.length, 1);
  assert.equal(group.id, '1-context');
  assert.equal(group.summary?.contextItems, 1);
  assert.equal(group.summary?.toolCalls, 0);
});

test('组 id 取首项 id，所以列表重建后展开状态跟得住', () => {
  const first: ChatDisplayItem = item(ChatItemKind.CONTEXT, '7-context');
  const group: ChatDisplayEntry = groupsOf(groupChatDisplay([
    first, item(ChatItemKind.TOOL, '8-tool'),
  ]))[0];

  assert.equal(group.id, '7-context');
  assert.equal(group.items[0], first);
});

test('过程组的列表 key 带前缀，避免与展开后的那条撞 key', () => {
  // 组 id 取的是组内首项 id，而那一项在展开时也会作为普通行出现 —— 两者 key 相同
  // 会让 ArkUI 的 ForEach 认成同一条目（展开瞬间错位/闪动）。
  const first: ChatDisplayItem = item(ChatItemKind.CONTEXT, '7-context');
  const entries: ChatDisplayEntry[] = groupChatDisplay([first, item(ChatItemKind.TOOL, '8-tool')]);

  assert.equal(chatDisplayEntryKey(entries[0]), 'process-7-context');
  assert.equal(chatDisplayEntryKey(ChatDisplayEntry.message(first)), '7-context');
});

// ── 消息类项必须真的挡住分区（折错了用户看不到正文） ──

test('失败行永远不被折进过程组', () => {
  // 终局失败是用户唯一能看到「为什么失败」的地方，两边各夹一次工具调用，
  // 结果必须是 3 个 entry（组 / 失败 / 组），失败那条独立成行。
  const failure: ChatDisplayItem = new ChatDisplayItem('3-failure', 3, ChatItemKind.FAILURE,
    null, '', false, [], [], [], new ChatTurnFailure('请求过于频繁', '429'));

  const entries: ChatDisplayEntry[] = groupChatDisplay([
    item(ChatItemKind.TOOL, '1-tool'), failure, item(ChatItemKind.TOOL, '4-tool'),
  ]);

  assert.equal(entries.length, 3);
  assert.deepEqual(messagesOf(entries), [failure]);
  assert.equal(groupsOf(entries).length, 2);
});

test('助手正文把一组劈成两组', () => {
  const entries: ChatDisplayEntry[] = groupChatDisplay([
    item(ChatItemKind.REASONING, '1-reasoning'),
    item(ChatItemKind.ASSISTANT, '2-assistant'),
    item(ChatItemKind.TOOL, '3-tool'),
  ]);

  assert.equal(entries.length, 3);
  assert.equal(entries[1].kind, ChatDisplayEntryKind.MESSAGE);
  // 正文把它们劈成两组：中间有结论，说明确实是两段工作，硬并会让「这组干了什么」失去意义。
  assert.deepEqual(groupItemIds(groupsOf(entries)[0]), ['1-reasoning']);
  assert.deepEqual(groupItemIds(groupsOf(entries)[1]), ['3-tool']);
});

// ── 计数 ──

test('合并后的工具行按明细条数计，不按行数', () => {
  // mergeToolRuns 会把**相邻**调用压成一行（明细都在 tools 里）。
  // 数行数会把「连续 3 次调用」报成 1 次，摘要就废了 —— 所以按明细条数计。
  const merged: ChatDisplayItem = item(ChatItemKind.TOOL, '6-tools', [tool('a'), tool('b'), tool('c')]);

  const group: ChatDisplayEntry = groupsOf(groupChatDisplay([merged]))[0];

  assert.equal(group.summary?.toolCalls, 3);
  assert.equal(group.items.length, 1);
});

test('拿不到明细的工具行仍算一次调用', () => {
  const group: ChatDisplayEntry = groupsOf(groupChatDisplay([item(ChatItemKind.TOOL, '1-tool')]))[0];

  assert.equal(group.summary?.toolCalls, 1);
});

// ── 摘要措辞（title 的四种分支） ──

test('不足 1 分时用「秒」', () => {
  const summary: ProcessGroupSummary = new ProcessGroupSummary(5, 3, 1000, 13000);

  assert.equal(summary.title(), '耗时 12 秒 · 3 项上下文 · 5 次工具调用');
});

// 起止时间戳**必须用非零的真实值**：`0` 在本协议里是「没有时间」的哨兵值
// （见 `ChatDisplayItem.time` 与 `ProcessGroupSummary.durationMs()` 的口径），
// 拿 `0` 当起点会把耗时整段吞掉 —— 想造「耗时 12 秒」得写成 `1000 → 13000`，不能写 `0 → 12000`。

test('超过 1 分用「分」，秒为 0 时省掉秒段', () => {
  assert.equal(new ProcessGroupSummary(0, 0, 1000, 73000).title(), '耗时 1 分 12 秒');
  assert.equal(new ProcessGroupSummary(0, 0, 1000, 121000).title(), '耗时 2 分');
  // 超过一小时也只到「分」为止：标题只有一行。
  assert.equal(new ProcessGroupSummary(0, 0, 1000, 3601000).title(), '耗时 60 分');
  // 不足 1 秒单列一档：向下取整会印成「耗时 0 秒」，那读起来就是「没有耗时」，
  // 与「整段省略」的表达撞车，用户分不清。
  assert.equal(new ProcessGroupSummary(0, 0, 1000, 1300).title(), '耗时 不足 1 秒');
});

test('没有可信耗时时就只显示计数', () => {
  assert.equal(new ProcessGroupSummary(2, 1).title(), '1 项上下文 · 2 次工具调用');
  // 只有一头有时间也不显示耗时：区间不完整就不是区间。
  assert.equal(new ProcessGroupSummary(2, 0, 1000, 0).title(), '2 次工具调用');
  assert.equal(new ProcessGroupSummary(2, 0, 0, 1000).title(), '2 次工具调用');
});

test('全为零时退回「过程」', () => {
  // 组头不能是空白 —— 空白看起来像渲染坏了。
  assert.equal(new ProcessGroupSummary().title(), '过程');
});

test('为零的计数段整段省略', () => {
  assert.equal(new ProcessGroupSummary(3, 0, 1000, 13000).title(), '耗时 12 秒 · 3 次工具调用');
  assert.equal(new ProcessGroupSummary(0, 1, 1000, 13000).title(), '耗时 12 秒 · 1 项上下文');
});

test('不可信的跨度一律不显示耗时', () => {
  // 时钟倒退（休眠恢复 / NTP 校时）：实测日志里有一条 bash 差 9821 秒，那不是执行时间。
  assert.equal(new ProcessGroupSummary(2, 0, 5000, 1000).durationMs(), 0);
  assert.equal(new ProcessGroupSummary(2, 0, 5000, 1000).title(), '2 次工具调用');
  // 同一毫秒：区间等于没有信息。
  assert.equal(new ProcessGroupSummary(2, 0, 5000, 5000).durationMs(), 0);
  // 可信区间照常给出来。
  assert.equal(new ProcessGroupSummary(0, 0, 1000, 13000).durationMs(), 12000);
});

test('formatProcessSpan 的三档边界', () => {
  assert.equal(formatProcessSpan(300), '不足 1 秒');
  assert.equal(formatProcessSpan(999), '不足 1 秒');
  // 恰好 1 秒就进「秒」档（取整向下）。
  assert.equal(formatProcessSpan(1000), '1 秒');
  assert.equal(formatProcessSpan(59999), '59 秒');
  assert.equal(formatProcessSpan(60000), '1 分');
  assert.equal(formatProcessSpan(61000), '1 分 1 秒');
});

// ── 时间来源的接缝 ──

test('耗时需要一个显式的时间来源（item 自身没有时间时就没有耗时段）', () => {
  const items: ChatDisplayItem[] = [
    item(ChatItemKind.CONTEXT, '1-context'),
    item(ChatItemKind.TOOL, '2-tool'),
  ];

  // 默认从 `item.time` 取，而这两条都没带时间 → 没有「耗时」段。
  // 这是刻意的诚实 —— 宁可少一段，也不编一个耗时。
  assert.equal(groupsOf(groupChatDisplay(items))[0].summary?.title(), '1 项上下文 · 1 次工具调用');

  // 传了时间来源就点亮：UI 侧按 id 查事件时间即可，本文件不用改。
  const times: Map<string, number> = new Map<string, number>([['1-context', 1000], ['2-tool', 73000]]);
  const wired: ChatDisplayEntry = groupsOf(
    groupChatDisplay(items, (entry: ChatDisplayItem): number => times.get(entry.id) ?? 0),
  )[0];

  assert.equal(wired.summary?.startedAt, 1000);
  assert.equal(wired.summary?.finishedAt, 73000);
  assert.equal(wired.summary?.title(), '耗时 1 分 12 秒 · 1 项上下文 · 1 次工具调用');
});

// ── 属性断言：分组不许丢项（本文件最重要的回归） ──

test('穷举所有 kind 序列，摊平后与输入逐条相同', () => {
  const sequences: ChatItemKind[][] = allKindSequences(4);
  assert.equal(sequences.length, 1554);

  let processGroups: number = 0;
  let messageEntries: number = 0;

  for (let s = 0; s < sequences.length; s++) {
    const kinds: ChatItemKind[] = sequences[s];
    const input: ChatDisplayItem[] = kinds.map((kind: ChatItemKind, index: number): ChatDisplayItem =>
      item(kind, `${index + 1}-${kind}`));
    const entries: ChatDisplayEntry[] = groupChatDisplay(input);
    const flat: ChatDisplayItem[] = flatten(entries);

    // 一条都不能丢、一条都不能多、顺序不能变。
    assert.deepEqual(flat, input, `摊平后与输入不同：${kinds.join(',')}`);
    assert.deepEqual(idsOf(flat), idsOf(input));

    // 反面保险：正文与失败行永远不许出现在组里。
    const groups: ChatDisplayEntry[] = groupsOf(entries);
    for (let g = 0; g < groups.length; g++) {
      const inside: string[] = groups[g].items.map((entry: ChatDisplayItem): string => entry.kind);
      for (let i = 0; i < inside.length; i++) {
        const folded: string = inside[i];
        const leaked: boolean = folded === ChatItemKind.USER || folded === ChatItemKind.ASSISTANT
          || folded === ChatItemKind.FAILURE;
        assert.ok(!leaked, `正文/失败行被折进了过程组：${kinds.join(',')} -> ${inside.join(',')}`);
      }
    }

    // 全是过程项 → 恰好一组；全是消息项 → 一个组都没有。
    const allProcess: boolean = kinds.every((kind: ChatItemKind): boolean =>
      kind === ChatItemKind.CONTEXT || kind === ChatItemKind.REASONING || kind === ChatItemKind.TOOL);
    const allMessages: boolean = kinds.every((kind: ChatItemKind): boolean =>
      kind === ChatItemKind.USER || kind === ChatItemKind.ASSISTANT || kind === ChatItemKind.FAILURE);
    if (allProcess) {
      assert.equal(groups.length, 1, `过程项应收成一组：${kinds.join(',')}`);
    }
    if (allMessages) {
      assert.equal(groups.length, 0, `消息项不该产组：${kinds.join(',')}`);
    }

    processGroups += groups.length;
    messageEntries += messagesOf(entries).length;
  }

  // 摊平断言单独看是**弱**的：一个「全部当消息」的实现也能通过它。
  // 所以再钉一次两类都真的出现过（上面那两条 if 是精确断言，这里是总量兜底）。
  assert.ok(processGroups > 0, '一条过程组都没产出，说明分区根本没生效');
  assert.ok(messageEntries > 0, '一条消息都没留下，说明正文被折进去了');
});

/**
 * 所有长度 1..4 的 kind 序列：6 + 36 + 216 + 1296 = 1554 条。
 *
 * 穷举而不是挑例子：分区的 bug 只在这类**相邻组合**上露头，
 * 比如「过程-消息-过程-过程」和「消息-过程-过程-消息」的收尾差别。
 */
function allKindSequences(maxLength: number): ChatItemKind[][] {
  const kinds: ChatItemKind[] = [
    ChatItemKind.USER, ChatItemKind.ASSISTANT, ChatItemKind.REASONING,
    ChatItemKind.CONTEXT, ChatItemKind.TOOL, ChatItemKind.FAILURE,
  ];
  const out: ChatItemKind[][] = [];
  const walk = (prefix: ChatItemKind[]): void => {
    if (prefix.length > 0) {
      out.push(prefix);
    }
    if (prefix.length >= maxLength) {
      return;
    }
    for (let i = 0; i < kinds.length; i++) {
      walk([...prefix, kinds[i]]);
    }
  };
  walk([]);
  return out;
}
