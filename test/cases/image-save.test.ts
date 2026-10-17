import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galleryFileName } from '../../entry/src/main/ets/core/ImageSave.ts';

/**
 * 「保存图片时该叫什么名字」的测试 —— 逐条对应原工程 `ChatImageViewer.kt` 的
 * `galleryFileNameTest`。
 *
 * 为什么值得测：会话里的图片常常是模型或工具落下的临时文件（`screenshot` / `img_0`），
 * 没有扩展名、或者扩展名是错的。保存时若名字错，用户在文件管理器/相册里根本打不开它，
 * 而这类故障反馈通常只会写成「保存了但看不到图」。
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

const PNG: Uint8Array = bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00);
const JPEG: Uint8Array = bytes(0xFF, 0xD8, 0xFF, 0xE0);
const GIF: Uint8Array = new Uint8Array([...'GIF89a'].map((c: string): number => c.charCodeAt(0)));
const HEIF: Uint8Array = new Uint8Array([
  ...'0000'.split('').map((): number => 0x20),
  ...'ftypheic'.split('').map((c: string): number => c.charCodeAt(0)),
]);
/** 认不出来的字节（这里用一段可读文本），用来验证「认不出就不动原名」。 */
const UNKNOWN: Uint8Array = new Uint8Array([...'hello'].map((c: string): number => c.charCodeAt(0)));

// ── 按魔数补扩展名 ──

test('没扩展名 + PNG → 补 .png', () => {
  assert.equal(galleryFileName('screenshot', PNG), 'screenshot.png');
});

test('没扩展名 + JPEG → 补 .jpg（不是 .jpeg）', () => {
  assert.equal(galleryFileName('screenshot', JPEG), 'screenshot.jpg');
});

test('没扩展名 + GIF → 补 .gif', () => {
  assert.equal(galleryFileName('screenshot', GIF), 'screenshot.gif');
});

test('没扩展名 + HEIF → 补 .heic', () => {
  assert.equal(galleryFileName('screenshot', HEIF), 'screenshot.heic');
});

// ── 已有合法图片扩展名 → 保留原名（不覆盖用户/上游起的名字） ──

test('已带 .png → 原样返回，即使字节是 JPEG', () => {
  assert.equal(galleryFileName('shot.png', JPEG), 'shot.png');
});

test('大写扩展名同样算数（大小写不敏感）', () => {
  assert.equal(galleryFileName('shot.PNG', JPEG), 'shot.PNG');
});

test('已带 .heif → 也算合法图片扩展名，不被改成 .heif.heic', () => {
  assert.equal(galleryFileName('shot.heif', HEIF), 'shot.heif');
});

// ── 扩展名存在但不是图片 → 补上正确的，而不替换 ──

test('非图片扩展名 → 补真正的扩展名（追加而非替换）', () => {
  assert.equal(galleryFileName('report.pdf', PNG), 'report.pdf.png');
});

test('伪装成文本的图片 → 补真正的扩展名', () => {
  assert.equal(galleryFileName('note.txt', PNG), 'note.txt.png');
});

// ── 取路径末段 ──

test('带路径 → 只取末段', () => {
  assert.equal(galleryFileName('/tmp/work/shot', JPEG), 'shot.jpg');
});

test('路径以斜杠结尾 → 末段为空，回落 image', () => {
  assert.equal(galleryFileName('/tmp/work/', JPEG), 'image.jpg');
});

// ── 空名 / 无字节 ──

test('名字为 null → 回落 image', () => {
  assert.equal(galleryFileName(null, PNG), 'image.png');
});

test('名字为空串 → 回落 image', () => {
  assert.equal(galleryFileName('', PNG), 'image.png');
});

test('名字只有空白 → 回落 image', () => {
  assert.equal(galleryFileName('   ', PNG), 'image.png');
});

test('没有字节（流式项还没读到图）→ 认不出格式，原样返回名字', () => {
  assert.equal(galleryFileName('screenshot', null), 'screenshot');
});

test('字节认不出格式 → 不动原名，宁可不补也不要塞一个错的类型', () => {
  assert.equal(galleryFileName('screenshot', UNKNOWN), 'screenshot');
});
