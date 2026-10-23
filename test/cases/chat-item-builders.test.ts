/**
 * `ChatItemBuilders.ts` —— Markdown 图片识别回归单测。
 * 对位 Android 源工程 `ChatPresentationTest.kt`（commit 5c4e1f0 / 9446c28）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKDOWN_IMAGE_PATTERN, markdownImageTarget, markdownImagePathsIn, stripMarkdownImages,
  handoffMediaType, assistantItems, userItems,
} from '../../entry/src/main/ets/core/ChatItemBuilders';
import { ChatItemKind, ChatDisplayItem } from '../../entry/src/main/ets/core/ChatPresentationTypes';
import { SessionEvent } from '../../entry/src/main/ets/core/Models';

// —— 造 fixture 的小工具 ——

function userEvent(seq: number, text: string): SessionEvent {
  const e = new SessionEvent();
  e.type = 'user/message';
  e.seq = seq;
  // data 是 Object 不是 JSON 字符串 —— SessionEvent.dataMap() 通过 JsonAccess.asMap(this.data) 解析。
  e.data = JSON.parse(JSON.stringify({
    source: { kind: 'user', name: 'terminal' },
    content: [{ type: 'text', text }],
  }));
  return e;
}

function assistantEvent(seq: number, blocks: Array<{ type: string; text?: string }>): SessionEvent {
  const e = new SessionEvent();
  e.type = 'assistant/message';
  e.seq = seq;
  e.data = JSON.parse(JSON.stringify({
    content: blocks,
  }));
  return e;
}

function onlyTextContent(text: string): SessionEvent {
  // 旧协议：content 是纯字符串，不是 { content: [...] } 数组。
  // 这种旧协议不支持 Markdown 图片识别，但也不该炸掉。
  const e = new SessionEvent();
  e.type = 'assistant/message';
  e.seq = 1;
  e.data = text;
  return e;
}

// —— MARKDOWN_IMAGE_PATTERN 相关 ——

test('Markdown 图片 pattern 基本识别', () => {
  const pat = new RegExp(MARKDOWN_IMAGE_PATTERN.source, 'g');
  assert.ok(pat.test('![alt](/path/img.png)'));
  pat.lastIndex = 0;
  assert.ok(pat.test('![](/path/img.png)'));
  pat.lastIndex = 0;
  assert.ok(!pat.test('[alt](/path/img.png)')); // 普通链接
});

test('markdownImageTarget 剥掉 title 和尖括号', () => {
  assert.equal(markdownImageTarget('/path/img.png'), '/path/img.png');
  assert.equal(markdownImageTarget('<path/with spaces.png>'), 'path/with spaces.png');
  assert.equal(markdownImageTarget('/path/img.png "My Title"'), '/path/img.png');
  // 只有引号没有配对前引号 → 整段 trim 后返回（兜底）
  assert.equal(markdownImageTarget('/path/img.png "Title'), '/path/img.png "Title');
});

test('markdownImagePathsIn 只收本地绝对路径 + 已知图片格式', () => {
  const text = '如图所示 ![c1](/media/report/c1.png) 和 ![g1](/media/report/g1.gif)。';
  assert.deepEqual(markdownImagePathsIn(text), ['/media/report/c1.png', '/media/report/g1.gif']);
});

test('markdownImagePathsIn 拒绝相对路径', () => {
  assert.deepEqual(markdownImagePathsIn('![x](./local.png)'), []);
});

test('markdownImagePathsIn 拒绝 http(s) 远程图', () => {
  assert.deepEqual(markdownImagePathsIn('![x](https://example.com/a.png)'), []);
});

// —— stripMarkdownImages ——

test('本地图片整段摘掉，不留空括号', () => {
  const out = stripMarkdownImages('开头\n![c1](/media/report/c1.png)\n结尾');
  assert.ok(out.indexOf('/media/report/c1.png') < 0, '图片路径不该留在正文里');
  assert.ok(out.indexOf('![') < 0, 'markdown 图片括号不该留在正文里');
});

test('http(s) 图片降级成普通链接', () => {
  const out = stripMarkdownImages('如图 ![remote](https://img.example.com/a.png)');
  assert.ok(out.indexOf('https://img.example.com/a.png') >= 0, '远程图片路径该保留');
  assert.ok(out.indexOf('![') < 0, 'markdown 图片标记不该留');
  assert.ok(out.indexOf('[remote]') >= 0, '应该降级成普通链接');
});

test('无扩展名或未知扩展名 → 留 alt 文字', () => {
  const out = stripMarkdownImages('![示意图](./fig)');
  assert.ok(out.indexOf('示意图') >= 0, 'alt 文字该保留');
});

test('摘完图片的连续空行压平', () => {
  const out = stripMarkdownImages('A\n\n\n\n![c](/x.png)\n\n\n\nB');
  // 最多剩 2 个连续换行
  assert.ok(!/\n{3,}/.test(out), '摘图后不该有超过 2 个连续换行');
});

// —— assistantItems 端到端 ——

test('助手正文里的 Markdown 图片 → 附件挂到 ASSISTANT，正文摘掉', () => {
  const ev = assistantEvent(10, [
    { type: 'text', text: '看图：![c1](/media/report/c1.png)' },
  ]);
  const items: ChatDisplayItem[] = assistantItems(ev);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.ASSISTANT);
  // 正文里不再有图片路径
  assert.ok(items[0].body.indexOf('/media/report/c1.png') < 0);
  // 附件里有这张图
  assert.equal(items[0].attachments.length, 1);
  assert.equal(items[0].attachments[0].name, 'c1.png');
});

test('助手只有图片没有文字 → 仍产出 ASSISTANT（P0-C 需要靠它认出"有可读的东西"）', () => {
  // 回归 9446c28：正文里只有图片时以前直接消失（items 长度 0），导致正文区留一块空白。
  const ev = assistantEvent(11, [
    { type: 'text', text: '![x](/p/a.png)' },
  ]);
  const items: ChatDisplayItem[] = assistantItems(ev);
  assert.equal(items.length, 1, '只贴图的消息不该整条消失');
  assert.equal(items[0].kind, ChatItemKind.ASSISTANT);
  assert.equal(items[0].attachments.length, 1);
});

test('带思考块的正文 → 图片挂到"思考之后的那段正文"上', () => {
  const ev = assistantEvent(12, [
    { type: 'reasoning', text: '让我想想' },
    { type: 'text', text: '答案是 ![c](/x.png)' },
  ]);
  const items: ChatDisplayItem[] = assistantItems(ev);
  const reasoning: ChatDisplayItem[] = items.filter(i => i.kind === ChatItemKind.REASONING);
  const messages: ChatDisplayItem[] = items.filter(i => i.kind === ChatItemKind.ASSISTANT);
  assert.equal(reasoning.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].attachments.length, 1);
});

// —— userItems 端到端 ——

test('用户话里的 Markdown 图片也 → 附件挂到 USER，正文摘掉', () => {
  const ev = userEvent(20, '看图：![c1](/media/report/c1.png)');
  const items: ChatDisplayItem[] = userItems(ev);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.USER);
  assert.ok(items[0].body.indexOf('/media/report/c1.png') < 0);
  assert.equal(items[0].attachments.length, 1);
});

test('助手 content 里有 message 包裹层（data.message.content）也能正确解析 Markdown 图片', () => {
  // 某些事件形态会把 content 包在 message 里，assistantItems 已做了 scope 兜底。
  const e = new SessionEvent();
  e.type = 'assistant/message';
  e.seq = 99;
  e.data = JSON.parse(JSON.stringify({
    message: {
      content: [{ type: 'text', text: '答案是 ![c](/x.png)' }],
    },
  }));
  const items: ChatDisplayItem[] = assistantItems(e);
  assert.equal(items.length, 1);
  assert.equal(items[0].attachments.length, 1);
  assert.equal(items[0].attachments[0].name, 'x.png');
});

// —— handoffMediaType 兜底 ——

test('handoffMediaType 兜底路径：文件名带空格、带奇怪扩展名都能优雅降级', () => {
  assert.equal(handoffMediaType('report 截图 c1.png'), 'image/png');
  assert.equal(handoffMediaType('weird.fakeext'), '');
  assert.equal(handoffMediaType('noext'), '');
});
