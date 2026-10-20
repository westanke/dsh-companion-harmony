import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileEntry } from '../../entry/src/main/ets/core/Models.ts';
import { OpenDocument } from '../../entry/src/main/ets/core/HarnessTypes.ts';

/**
 * 「有未保存的改动」判据 —— 移植自源工程 `OpenDocument.hasUnsavedChanges`。
 *
 * 钉的是 v2.2.44 的缺陷 W3：编辑器里改了字，顶栏保存键没有任何脏状态指示，
 * 直接点返回也没有任何提示就退回目录 —— 改动静默丢失。
 * 一个不报错的丢数据，比一次报错严重得多：用户以为存上了，下次打开还是旧内容。
 */

function entry(path: string = 'a.txt'): FileEntry {
  const e: FileEntry = new FileEntry();
  e.path = path;
  e.kind = 'file';
  return e;
}

function textDoc(text: string): OpenDocument {
  return new OpenDocument(entry(), text, 'e1', false, '\n', 'text/plain', null, false, text);
}

test('未改动：正文与打开时一致，不算脏', () => {
  assert.equal(textDoc('hello').hasUnsavedChanges(), false);
});

test('改过：正文与打开时不一致，算脏', () => {
  assert.equal(textDoc('hello').withText('hello world').hasUnsavedChanges(), true);
});

test('改回原文：不算脏（逐字比，没有「改过就一直脏」）', () => {
  const doc: OpenDocument = textDoc('hello').withText('changed').withText('hello');
  assert.equal(doc.hasUnsavedChanges(), false);
});

test('非文本（图片 / PDF / 超大文件）：没有基线，谈不上改动', () => {
  const image: OpenDocument = new OpenDocument(entry('a.png'), null, 'e1', false, '\n',
    'image/png', new Uint8Array([1, 2, 3]), false, null);
  assert.equal(image.hasUnsavedChanges(), false);
});

test('保存成功：基线跟着挪到刚写进去的正文，脏状态清零', () => {
  const saved: OpenDocument = textDoc('hello').withText('hello!').withSaved('e2');
  assert.equal(saved.etag, 'e2');
  assert.equal(saved.hasUnsavedChanges(), false);
  // 保存之后再改，仍然要能重新变脏。
  assert.equal(saved.withText('hello!!').hasUnsavedChanges(), true);
});

test('只改正文不会动基线：脏状态必须一直可见，直到保存', () => {
  const edited: OpenDocument = textDoc('hello').withText('hello!');
  assert.equal(edited.originalText, 'hello');
  assert.equal(edited.hasUnsavedChanges(), true);
  // 丢弃的语义就是「回目录、不采用这份正文」——后续再打开会重新读盘，与这份对象无关。
});
