import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatLinkReason, ChatLinkTarget, ChatLinkTargetKind,
} from '../../entry/src/main/ets/core/ChatLinkTarget.ts';

/**
 * 链接分流测试 —— 逐条对应原工程 `ChatLinkTargetTest.kt`。
 *
 * 这组断言存在的理由：分流错了的代价不对称 —— 把相对路径猜成绝对路径可能打开**另一个**
 * 文件；把 `mailto:` 丢给路径解析会得到一句莫名其妙的「路径不存在」。
 * 所以「不确定就明确说不支持」这条边界必须被钉住。
 */

test('绝对路径交给服务端解析', () => {
  const target = ChatLinkTarget.classify('/media/wangke/OFFICE/workspace/今日工作汇总_2026-10-09.md');
  assert.equal(target.kind, ChatLinkTargetKind.SERVER_PATH);
  assert.equal(target.path, '/media/wangke/OFFICE/workspace/今日工作汇总_2026-10-09.md');
  assert.equal(target.reason, null);
});

test('http / https 交给浏览器，且 scheme 大小写不敏感', () => {
  const http = ChatLinkTarget.classify('http://example.com/a');
  assert.equal(http.kind, ChatLinkTargetKind.WEB);
  assert.equal(http.path, 'http://example.com/a');

  const https = ChatLinkTarget.classify('https://example.com/a');
  assert.equal(https.kind, ChatLinkTargetKind.WEB);

  // scheme 大小写不敏感是 URL 的既有约定。
  const upper = ChatLinkTarget.classify('HTTPS://example.com');
  assert.equal(upper.kind, ChatLinkTargetKind.WEB);
  assert.equal(upper.path, 'HTTPS://example.com');
});

test('协议相对 URL 是网页，不是服务端路径', () => {
  // `//host/path` 以 / 开头，但它是网页。这条如果判错，用户点网页会去解析服务端路径。
  const target = ChatLinkTarget.classify('//example.com/x');
  assert.equal(target.kind, ChatLinkTargetKind.WEB);
  assert.equal(target.path, 'https://example.com/x');
});

test('相对路径明确拒绝，绝不猜基准目录', () => {
  // 用户真机上点不开的就是这一种：写成相对路径的 Markdown 链接。
  // 服务端 roots/resolve 只接受绝对路径，猜基准目录可能打开另一个文件。
  const target = ChatLinkTarget.classify('今日工作汇总_2026-10-09.md');
  assert.equal(target.kind, ChatLinkTargetKind.UNSUPPORTED);
  assert.equal(target.reason, ChatLinkReason.RELATIVE_PATH);
});

test('空目标被拒绝', () => {
  for (const raw of ['', '   ', '\n', '\u3000']) {
    const target = ChatLinkTarget.classify(raw);
    assert.equal(target.kind, ChatLinkTargetKind.UNSUPPORTED, `空串应被拒绝: ${JSON.stringify(raw)}`);
    assert.equal(target.reason, ChatLinkReason.EMPTY);
  }
});

test('页内锚点被拒绝', () => {
  const target = ChatLinkTarget.classify('#section-3');
  assert.equal(target.reason, ChatLinkReason.ANCHOR);
});

test('其他 scheme 一律拒绝', () => {
  // mailto / tel / data / file 都不处理：手机与服务端不是同一台机器，
  // 「本地文件」在远程场景下没有意义；而 mailto 丢给路径解析只会产生噪音。
  for (const raw of ['mailto:a@b.com', 'tel:+8613800000000', 'data:text/plain,hi', 'file:///etc/passwd']) {
    const target = ChatLinkTarget.classify(raw);
    assert.equal(target.kind, ChatLinkTargetKind.UNSUPPORTED, `应被拒绝: ${raw}`);
    assert.equal(target.reason, ChatLinkReason.UNKNOWN_SCHEME, `${raw} 应归为未知 scheme`);
  }
});

test('首尾空白被忽略（Markdown 链接里很常见）', () => {
  const target = ChatLinkTarget.classify('  /tmp/x.md  ');
  assert.equal(target.kind, ChatLinkTargetKind.SERVER_PATH);
  assert.equal(target.path, '/tmp/x.md');
});

test('不支持的形态保留原始目标，便于排查', () => {
  const raw = 'some/relative/file.md';
  const target = ChatLinkTarget.classify(raw);
  assert.equal(target.kind, ChatLinkTargetKind.UNSUPPORTED);
  // 保留的是**原始**串（含首尾空白），不是裁剪后的 —— 排查时看到的就是用户点的那一串。
  assert.equal(target.path, raw);
  assert.equal(ChatLinkTarget.classify('  x/y.md  ').path, '  x/y.md  ');
});

test('isUnsupported 只对第三种形态为真', () => {
  assert.equal(ChatLinkTarget.classify('/a.md').isUnsupported(), false);
  assert.equal(ChatLinkTarget.classify('http://a').isUnsupported(), false);
  assert.equal(ChatLinkTarget.classify('a.md').isUnsupported(), true);
});

test('只有单个冒号的裸 scheme 也算未知 scheme', () => {
  const target = ChatLinkTarget.classify('ftp://host/x');
  assert.equal(target.reason, ChatLinkReason.UNKNOWN_SCHEME);
});
