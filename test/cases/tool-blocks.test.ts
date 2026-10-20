import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolBlockKind, extractReadBody, stripAnsiEscapes, toolBlockView,
} from '../../entry/src/main/ets/core/ToolBlocks.ts';
import { ToolCallDetail } from '../../entry/src/main/ets/core/ChatPresentationTypes.ts';

/**
 * 工具调用专用块分发的门禁（对标源工程 `ChatToolBlocksTest.kt`，源 v2.2.43）。
 *
 * 铁律：**解析失败一律回落 Generic** —— 专用块是增强不是依赖。
 * 这批用例专门喂畸形输入（坏 JSON、缺字段、空 result）钉住这条退路，
 * 以及钉住「空参数」与「坏 JSON」的区别（前者照常分发，后者才回落）。
 */

function tool(name: string, argumentsJson: string, result: string | null = null, failed: boolean = false): ToolCallDetail {
  return new ToolCallDetail('c1', name, argumentsJson, result, failed, null);
}

// ------------------------------------------------------------ 分发

test('bash 分发为 Terminal 且保留命令与输出', () => {
  const view = toolBlockView(tool('bash', '{"command":"ls -la","description":"列目录"}', 'file1\nfile2'));
  assert.equal(view.kind, ToolBlockKind.Terminal);
  assert.equal(view.command, 'ls -la');
  assert.equal(view.description, '列目录');
  assert.equal(view.output, 'file1\nfile2');
  assert.equal(view.running, false);
});

test('bash 无结果是运行中', () => {
  const view = toolBlockView(tool('bash', '{"command":"sleep 5"}', null));
  assert.equal(view.kind, ToolBlockKind.Terminal);
  assert.equal(view.running, true);
});

test('bash 有空输出但不是运行中', () => {
  // `""`（跑完了没输出）与 `null`（还在跑）必须分开，这条就是防合并的。
  const view = toolBlockView(tool('bash', '{"command":"true"}', ''));
  assert.equal(view.running, false);
  assert.equal(view.output, '');
});

test('read 分发为 Read 并剥出正文', () => {
  const result = '<path>/tmp/a.kt</path>\n<type>file</type>\n<content>\n1: package a\n2: class B\n</content>';
  const view = toolBlockView(tool('read', '{"file_path":"/tmp/a.kt","offset":1,"limit":120}', result));
  assert.equal(view.kind, ToolBlockKind.Read);
  assert.equal(view.path, '/tmp/a.kt');
  assert.equal(view.offset, 1);
  assert.equal(view.limit, 120);
  assert.equal(view.hasLineNumbers, true);
  assert.ok(view.body.startsWith('1: package a'));
});

test('read_image 与无行号正文', () => {
  const view = toolBlockView(tool('read_image', '{"file_path":"/tmp/p.png"}',
    '<path>/tmp/p.png</path>\n<content>…</content>'));
  assert.equal(view.kind, ToolBlockKind.Read);
  assert.equal(view.path, '/tmp/p.png');
  assert.equal(view.hasLineNumbers, false);
});

test('edit 分发为 Diff 且带 replace_all', () => {
  const view = toolBlockView(
    tool('edit', '{"file_path":"/a.kt","old_string":"val a","new_string":"val b","replace_all":true}'));
  assert.equal(view.kind, ToolBlockKind.Diff);
  assert.equal(view.path, '/a.kt');
  assert.equal(view.oldText, 'val a');
  assert.equal(view.newText, 'val b');
  assert.equal(view.replaceAll, true);
});

test('write 分发为新建 Diff 无旧文', () => {
  const view = toolBlockView(tool('write', '{"file_path":"/n.md","content":"# hi"}'));
  assert.equal(view.kind, ToolBlockKind.Diff);
  assert.equal(view.oldText, null);
  assert.equal(view.newText, '# hi');
  assert.equal(view.replaceAll, false);
});

test('未知工具回落 Generic', () => {
  const view = toolBlockView(tool('grep', '{"pattern":"x"}', 'match'));
  assert.equal(view.kind, ToolBlockKind.Generic);
  assert.ok(view.formattedArguments.includes('pattern'));
});

// ------------------------------------------------------------ 畸形输入回落

test('坏 JSON 回落 Generic', () => {
  const view = toolBlockView(tool('read', '{not-json', 'x'));
  assert.equal(view.kind, ToolBlockKind.Generic);
});

test('空参数不崩且按工具名正常分发', () => {
  // 空参数对任何工具都是合法输入（= 没有参数），应正常分发而不是崩或回落。
  const bash = toolBlockView(tool('bash', '', ''));
  assert.equal(bash.kind, ToolBlockKind.Terminal);
  assert.equal(bash.command, '');
  const read = toolBlockView(tool('read', '', 'x'));
  assert.equal(read.kind, ToolBlockKind.Read);
  assert.equal(read.path, '');
  // JSON 非对象（如 null / 数组）才回落 Generic。
  assert.equal(toolBlockView(tool('read', 'null', 'x')).kind, ToolBlockKind.Generic);
  assert.equal(toolBlockView(tool('read', '[]', 'x')).kind, ToolBlockKind.Generic);
  assert.equal(toolBlockView(tool('read', '42', 'x')).kind, ToolBlockKind.Generic);
});

test('read result 缺 content 包装时正文退回原样', () => {
  const view = toolBlockView(tool('read', '{"file_path":"/a"}', '裸输出'));
  assert.equal(view.kind, ToolBlockKind.Read);
  assert.equal(view.body, '裸输出');
  assert.equal(view.hasLineNumbers, false);
});

test('read result 为 null 时正文为空', () => {
  const view = toolBlockView(tool('read', '{"file_path":"/a"}', null));
  assert.equal(view.kind, ToolBlockKind.Read);
  assert.equal(view.body, '');
  assert.equal(view.hasLineNumbers, false);
});

test('read 字段类型不符按缺省处理（不回落）', () => {
  // offset 给了字符串、file_path 给了数字：这是「字段类型不符」，取值退默认，
  // 但 arguments 本身是合法对象，所以仍按 read 分发 —— 内容不丢。
  const view = toolBlockView(tool('read', '{"file_path":7,"offset":"1"}', 'x'));
  assert.equal(view.kind, ToolBlockKind.Read);
  assert.equal(view.path, '');
  assert.equal(view.offset, null);
});

// ------------------------------------------------------------ ANSI 剥离

test('无转义序列时原样返回', () => {
  assert.equal(stripAnsiEscapes('plain text'), 'plain text');
});

test('CSI 颜色码被剥除', () => {
  assert.equal(stripAnsiEscapes('\u001B[32mdone\u001B[0m'), 'done');
  assert.equal(stripAnsiEscapes('a\u001B[1;34mb'), 'ab');
});

test('OSC 序列被剥除', () => {
  assert.equal(stripAnsiEscapes('\u001B]0;title\u0007ok'), 'ok');
  assert.equal(stripAnsiEscapes('\u001B]8;;http://x\u001B\\ok'), 'ok');
});

test('残缺序列不吞正文', () => {
  // 残缺的 CSI（后跟非参数/非终止字节）：吞掉 ESC[ 与其后已扫过的参数，正文保留。
  assert.equal(stripAnsiEscapes('\u001B[3\ntail'), '\ntail');
  // 未闭合的 OSC：吞到结尾，不输出乱码。
  assert.equal(stripAnsiEscapes('head\u001B]0;never-closed'), 'head');
  // 末尾一个裸 ESC：吞掉，不留半个字符。
  assert.equal(stripAnsiEscapes('tail\u001B'), 'tail');
});

test('终端输出整体过一遍 ANSI 剥离', () => {
  const view = toolBlockView(tool('bash', '{"command":"ls"}', '\u001B[31merr\u001B[0m ok'));
  assert.equal(view.output, 'err ok');
});

// ------------------------------------------------------------ 行号判据

test('行号判据只认 N 冒号空格前缀', () => {
  const withNumbers = extractReadBody('<content>\n1: a\n2: b\n</content>');
  assert.equal(withNumbers.hasLineNumbers, true);
  assert.ok(withNumbers.body.startsWith('1: a'));

  const plain = extractReadBody('<content>\nplain\n</content>');
  assert.equal(plain.hasLineNumbers, false);

  // 空行开头的正文：判据看首个非空行。
  const blankFirst = extractReadBody('<content>\n\n7: mid\n</content>');
  assert.equal(blankFirst.hasLineNumbers, true);

  // 只有「数字 + 冒号 + 一个空格」才算，`1:` 后没空格、或 `1:a` 都不算。
  assert.equal(extractReadBody('<content>\n1:a\n</content>').hasLineNumbers, false);
  assert.equal(extractReadBody('<content>\na: b\n</content>').hasLineNumbers, false);
});
