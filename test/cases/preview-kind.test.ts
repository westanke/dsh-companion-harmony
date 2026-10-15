import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ImageFormat, PREVIEW_IMAGE_MAX_BYTES, PREVIEW_IMAGE_MAX_PIXELS, PREVIEW_PDF_MAX_BYTES,
  PREVIEW_PDF_MAX_PAGES, PreviewKind, binaryPreviewByteLimit, previewKind, previewKindOf,
  sampleSizeFor, sniffImageFormat,
} from '../../entry/src/main/ets/core/PreviewKind.ts';

/**
 * 预览分派测试 —— 逐条对应原工程 `PreviewKindTest.kt`。
 *
 * 这组断言存在的理由：判错的代价是**用户看到乱码**。把二进制当 UTF-8 解出来是一屏替换
 * 字符；把 `.md` 说成源码则让用户看 `# 标题` 而看不到标题。所以「扩展名优先」「二进制
 * 永远不走文本」「魔数只做升级」这三条边界都要钉住。
 */

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xFF;
  }
  return out;
}

function concatBytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      out[cursor++] = part[i];
    }
  }
  return out;
}

test('扩展名优先于 contentType（MIME 在本地机器上五花八门）', () => {
  assert.equal(previewKind('README.md', 'text/plain'), PreviewKind.MARKDOWN);
  assert.equal(previewKind('index.html', 'text/plain'), PreviewKind.HTML);
});

test('裸文件名也能取到扩展名（上游踩过的坑）', () => {
  // 早先的「先 substringAfterLast(/) 再 substringAfterLast(.)」会把 README.md 当成
  // 「扩展名 = README.md」，一个都匹配不上，静默退化成源码预览。
  assert.equal(previewKind('README.md'), PreviewKind.MARKDOWN);
  assert.equal(previewKind('a.PNG'), PreviewKind.IMAGE);
  assert.equal(previewKind('A.Png'), PreviewKind.IMAGE);
});

test('图片扩展名不会被二进制判定抢先', () => {
  // 二进制判定在前的实现会把 png 永远判成 BINARY，图片分支一行都跑不到。
  assert.equal(previewKind('shot.png', 'application/octet-stream'), PreviewKind.IMAGE);
  assert.equal(previewKind('shot.heic'), PreviewKind.IMAGE);
});

test('二进制扩展名永远不走文本预览，不管 MIME 说什么', () => {
  assert.equal(previewKind('a.zip', 'text/plain'), PreviewKind.BINARY);
  assert.equal(previewKind('a.mp3', 'text/plain'), PreviewKind.BINARY);
  assert.equal(previewKind('a.so'), PreviewKind.BINARY);
  assert.equal(previewKind('a.db'), PreviewKind.BINARY);
});

test('pdf 与 markdown / html 各自成类', () => {
  assert.equal(previewKind('a.pdf'), PreviewKind.PDF);
  assert.equal(previewKind('a.htm'), PreviewKind.HTML);
  assert.equal(previewKind('a.xhtml'), PreviewKind.HTML);
  assert.equal(previewKind('a.markdown'), PreviewKind.MARKDOWN);
});

test('扩展名不认识时退回 contentType', () => {
  assert.equal(previewKind('noext', 'image/png'), PreviewKind.IMAGE);
  assert.equal(previewKind('noext', 'application/pdf'), PreviewKind.PDF);
  assert.equal(previewKind('noext', 'text/html'), PreviewKind.SOURCE);
  assert.equal(previewKind('noext', 'application/json'), PreviewKind.SOURCE);
  assert.equal(previewKind('noext', 'audio/mpeg'), PreviewKind.BINARY);
  assert.equal(previewKind('noext', 'application/octet-stream'), PreviewKind.BINARY);
  // 无扩展名且 MIME 也认不出 → 源码兜底，而不是二进制。
  assert.equal(previewKind('noext', null), PreviewKind.SOURCE);
  assert.equal(previewKind('noext', '   '), PreviewKind.SOURCE);
  assert.equal(previewKind('noext', 'TEXT/PLAIN'), PreviewKind.SOURCE);
});

test('点在开头或末尾都不算扩展名', () => {
  assert.equal(previewKind('.gitignore'), PreviewKind.SOURCE);
  assert.equal(previewKind('a.'), PreviewKind.SOURCE);
});

test('路径取最后一段的扩展名', () => {
  assert.equal(previewKind('/tmp/dir/x.ts', null), PreviewKind.SOURCE);
  assert.equal(previewKind('/tmp/带.点的目录/readme.md', null), PreviewKind.MARKDOWN);
});

test('魔数只做升级，不推翻名字已明确给出的意图', () => {
  const png = concatBytes([0x89], [0x50, 0x4E, 0x47], [0x0D, 0x0A, 0x1A, 0x0A]);
  // Markdown / HTML 尊重名字：那是用户点开它的意图。
  assert.equal(previewKindOf('a.md', null, png), PreviewKind.MARKDOWN);
  assert.equal(previewKindOf('a.html', null, png), PreviewKind.HTML);
  // SOURCE / BINARY 才接受升级：没有扩展名的截图正好落在这两档。
  assert.equal(previewKindOf('screenshot', null, png), PreviewKind.IMAGE);
  assert.equal(previewKindOf('a.dat', 'application/octet-stream', png), PreviewKind.IMAGE);
  // 没读到字节时等价于 previewKind。
  assert.equal(previewKindOf('screenshot', null, null), PreviewKind.SOURCE);
  // 已经明确是图片就照旧。
  assert.equal(previewKindOf('a.png', null, null), PreviewKind.IMAGE);
});

test('sniffImageFormat 按魔数认图片', () => {
  const png = concatBytes([0x89], [0x50, 0x4E, 0x47], [0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(sniffImageFormat(png), ImageFormat.PNG);
  assert.equal(sniffImageFormat(concatBytes([0xFF, 0xD8, 0xFF])), ImageFormat.JPEG);
  assert.equal(sniffImageFormat(asciiBytes('GIF87a')), ImageFormat.GIF);
  assert.equal(sniffImageFormat(asciiBytes('GIF89a')), ImageFormat.GIF);
  assert.equal(sniffImageFormat(asciiBytes('RIFF')), null);
  assert.equal(sniffImageFormat(concatBytes(asciiBytes('RIFF'), [0, 0, 0, 0], asciiBytes('WEBP'))),
    ImageFormat.WEBP);
  assert.equal(sniffImageFormat(concatBytes([0, 0, 0, 0], asciiBytes('ftyp'), asciiBytes('avif'))),
    ImageFormat.AVIF);
  assert.equal(sniffImageFormat(concatBytes([0, 0, 0, 0], asciiBytes('ftyp'), asciiBytes('heic'))),
    ImageFormat.HEIF);
  assert.equal(sniffImageFormat(concatBytes([0, 0, 0, 0], asciiBytes('ftyp'), asciiBytes('zzzz'))),
    null);
});

test('BMP 要 DIB 头长度在已知集合里，只认 BM 两个字母会误判文本', () => {
  const valid = concatBytes([0x42, 0x4D], [0, 0, 0, 0], [0, 0, 0, 0], [40, 0, 0, 0]);
  assert.equal(sniffImageFormat(valid), ImageFormat.BMP);
  const badDib = concatBytes([0x42, 0x4D], [0, 0, 0, 0], [0, 0, 0, 0], [7, 0, 0, 0]);
  assert.equal(sniffImageFormat(badDib), null);
  // 「BM…」开头的文本不该被判成图片。
  assert.equal(sniffImageFormat(asciiBytes('BMxxxx')), null);
});

test('半截文件与纯文本一律 null，不瞎猜', () => {
  assert.equal(sniffImageFormat(concatBytes([0x89], [0x50, 0x4E])), null);
  assert.equal(sniffImageFormat(asciiBytes('plain text, definitely not an image')), null);
  assert.equal(sniffImageFormat(null), null);
  assert.equal(sniffImageFormat(new Uint8Array(0)), null);
});

test('字节上限只有一份真值', () => {
  assert.equal(binaryPreviewByteLimit(PreviewKind.IMAGE), PREVIEW_IMAGE_MAX_BYTES);
  assert.equal(binaryPreviewByteLimit(PreviewKind.PDF), PREVIEW_PDF_MAX_BYTES);
  assert.equal(binaryPreviewByteLimit(PreviewKind.SOURCE), null);
  assert.equal(binaryPreviewByteLimit(PreviewKind.MARKDOWN), null);
  assert.equal(binaryPreviewByteLimit(PreviewKind.BINARY), null);
  assert.equal(PREVIEW_IMAGE_MAX_BYTES, 24 * 1024 * 1024);
  assert.equal(PREVIEW_PDF_MAX_BYTES, 32 * 1024 * 1024);
  assert.equal(PREVIEW_PDF_MAX_PAGES, 100);
  assert.equal(PREVIEW_IMAGE_MAX_PIXELS, 12000000);
});

test('sampleSizeFor 取 2 的幂且不超像素上限', () => {
  assert.equal(sampleSizeFor(8000, 6000), 2);
  assert.equal(sampleSizeFor(20000, 20000), 8);
  // 恰好等于上限不算超。
  assert.equal(sampleSizeFor(4000, 3000), 1);
  assert.equal(sampleSizeFor(100, 100), 1);
  assert.equal(sampleSizeFor(0, 10), 1);
  assert.equal(sampleSizeFor(-1, -1), 1);
});
