import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_EMPTY_CONTENT, ERROR_IMAGE_TOO_LARGE, MAX_FILE_BYTES, MAX_IMAGE_BYTES, base64Of,
  bodyBytesOf, formatBytes, imageMediaType, imagePart, messageBody, readAtMost, uploadPayload,
  type ByteSource,
} from '../../entry/src/main/ets/core/ChatContentParts.ts';
import { PromptPart } from '../../entry/src/main/ets/core/Models.ts';
import { utf8Decode } from '../../entry/src/main/ets/core/Codec.ts';

/** 从内存字节里按块读（模拟平台的文件流）。 */
class MemorySource implements ByteSource {
  private bytes: Uint8Array;
  private pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  read(buffer: Uint8Array, offset: number, length: number): number {
    if (this.pos >= this.bytes.length) {
      return -1;
    }
    const n = Math.min(length, this.bytes.length - this.pos);
    for (let i = 0; i < n; i++) {
      buffer[offset + i] = this.bytes[this.pos + i];
    }
    this.pos += n;
    return n;
  }
}

function bytesOf(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (i * 31 + seed) % 256;
  }
  return out;
}

// --- 发消息体 ---------------------------------------------------------------

test('messageBody：纯文本走旧格式 {"text":...}（不强迫老插件升级）', () => {
  const body = JSON.parse(messageBody([PromptPart.text('你好')], 'queue', 'Asia/Shanghai', 'req-1'));
  assert.deepEqual(body, { text: '你好', mode: 'queue', clientTimeZone: 'Asia/Shanghai', clientRequestId: 'req-1' });
  assert.equal('content' in body, false);
});

test('messageBody：带附件走 content 数组，且不再出现 text 键', () => {
  const body = JSON.parse(messageBody(
    [PromptPart.text('看图'), PromptPart.file('rc1')], 'steer', 'UTC', 'req-2',
  ));
  assert.equal('text' in body, false);
  assert.deepEqual(body.content, [{ type: 'text', text: '看图' }, { type: 'file', receiptId: 'rc1' }]);
  assert.equal(body.mode, 'steer');
  assert.equal(body.clientTimeZone, 'UTC');
  assert.equal(body.clientRequestId, 'req-2');
});

test('messageBody：纯图片（无文本）也走 content 数组', () => {
  const body = JSON.parse(messageBody([PromptPart.image('image/png', 'AAAA')], 'queue', 'UTC', 'r'));
  assert.deepEqual(body.content, [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]);
});

test('messageBody：去掉空白文本 part 后为空 → 抛 EMPTY_CONTENT', () => {
  assert.throws(() => messageBody([PromptPart.text('   ')], 'queue', 'UTC', 'r'), (e: unknown) => {
    assert.equal((e as Error).message, ERROR_EMPTY_CONTENT);
    return true;
  });
  assert.throws(() => messageBody([], 'queue', 'UTC', 'r'), new RegExp(ERROR_EMPTY_CONTENT));
});

test('messageBody：空白 part 被剔除，剩下的非空文本才决定是否走旧格式', () => {
  const body = JSON.parse(messageBody([PromptPart.text('  '), PromptPart.text('正文')], 'queue', 'UTC', 'r'));
  assert.deepEqual(body, { text: '正文', mode: 'queue', clientTimeZone: 'UTC', clientRequestId: 'r' });
});

test('messageBody：两个文本 part 不走旧格式（旧格式只能表达一段文本）', () => {
  const body = JSON.parse(messageBody([PromptPart.text('A'), PromptPart.text('B')], 'queue', 'UTC', 'r'));
  assert.deepEqual(body.content, [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]);
});

// --- 图片 -------------------------------------------------------------------

test('imagePart：内联 base64 用标准字母表（含 + / =，不是 URL-safe）', () => {
  // 0xFB 0xFF 0xBF → 标准 base64 为 "+/+/"，URL-safe 会变成 "-_-_"
  const part = imagePart('image/png', new Uint8Array([0xFB, 0xFF, 0xBF]));
  assert.equal(part.data, '+/+/');
  const body = JSON.parse(part.toJsonString());
  assert.deepEqual(body, { type: 'image', mediaType: 'image/png', data: '+/+/' });
});

test('imagePart：恰好 8 MiB 通过，超出 1 字节抛 IMAGE_TOO_LARGE', () => {
  assert.equal(MAX_IMAGE_BYTES, 8 * 1024 * 1024);
  const ok = imagePart('image/png', bytesOf(MAX_IMAGE_BYTES));
  assert.equal(ok.type, 'image');

  assert.throws(() => imagePart('image/png', bytesOf(MAX_IMAGE_BYTES + 1)), (e: unknown) => {
    assert.equal((e as Error).message, ERROR_IMAGE_TOO_LARGE);
    return true;
  });
});

test('imagePart：文件名空白时按「没有名字」处理（不写 name 键）', () => {
  const noName = imagePart('image/png', new Uint8Array([1]), null);
  assert.equal('name' in JSON.parse(noName.toJsonString()), false);
  const blank = imagePart('image/png', new Uint8Array([1]), '   ');
  assert.equal('name' in JSON.parse(blank.toJsonString()), false);
  const named = imagePart('image/png', new Uint8Array([1]), 'shot.png');
  assert.equal(JSON.parse(named.toJsonString()).name, 'shot.png');
});

test('imageMediaType：声明优先，扩展名兜底，最后退到 image/png', () => {
  assert.equal(imageMediaType('image/jpeg', 'a.png'), 'image/jpeg', '系统给的 MIME 优先');
  assert.equal(imageMediaType('IMAGE/JPEG', 'a.png'), 'image/jpeg', '大小写归一');
  assert.equal(imageMediaType('application/octet-stream', 'a.JPG'), 'image/jpeg', '非 image/* 不采信，改看扩展名');
  assert.equal(imageMediaType(null, 'a.JPG'), 'image/jpeg');
  assert.equal(imageMediaType(null, 'a.webp'), 'image/webp');
  assert.equal(imageMediaType(null, 'a.gif'), 'image/gif');
  assert.equal(imageMediaType(null, 'a.heic'), 'image/heic');
  assert.equal(imageMediaType(null, 'a.heif'), 'image/heic');
  assert.equal(imageMediaType(null, 'a.bmp'), 'image/bmp');
  assert.equal(imageMediaType(null, 'a.png'), 'image/png');
  assert.equal(imageMediaType(null, '没有扩展名'), 'image/png', '兜底 image/png，不该让用户发不出去');
  assert.equal(imageMediaType('', 'a.jpeg'), 'image/jpeg');
});

// --- 读取上限 ---------------------------------------------------------------

test('readAtMost：读满上限时不含「多读的那一字节」，可判为完整文件', () => {
  const limit = 1000;
  const limitPlusOne = readAtMost(limit, new MemorySource(bytesOf(limit + 1)));
  assert.equal(limitPlusOne.length, limit + 1, '多读一字节正是为了区分「读完」与「被截断」');

  const exact = readAtMost(limit, new MemorySource(bytesOf(limit)));
  assert.equal(exact.length, limit, '正好等于上限：读完了，应放行');
  const bigger = readAtMost(limit, new MemorySource(bytesOf(limit + 50)));
  assert.equal(bigger.length, limit + 1, '超过上限：只会拿到 limit+1，调用方据此拒绝');
});

test('readAtMost：小文件完整读出，内容与源一致', () => {
  const source = bytesOf(37);
  const out = readAtMost(MAX_FILE_BYTES, new MemorySource(source), 8);
  assert.deepEqual([...out], [...source]);
});

test('readAtMost：空源返回空数组而不是死循环', () => {
  assert.equal(readAtMost(100, new MemorySource(new Uint8Array(0))).length, 0);
});

test('readAtMost：跨块拼接正确（chunkSize 小于文件长度时）', () => {
  const source = bytesOf(300);
  const out = readAtMost(MAX_FILE_BYTES, new MemorySource(source), 64);
  assert.equal(out.length, 300);
  assert.deepEqual([...out], [...source]);
});

test('readAtMost：源提前返回 -1 时立刻收尾（读到一半就没有了）', () => {
  let calls = 0;
  const partial: ByteSource = {
    read: (buffer, offset, length) => {
      calls += 1;
      if (calls > 1) {
        return -1;
      }
      for (let i = 0; i < 5; i++) {
        buffer[offset + i] = 9;
      }
      return 5;
    },
  };
  const out = readAtMost(10, partial, 100);
  assert.equal(out.length, 5, '第二块就断了，不该继续凑到 limit');
  assert.equal(out[0], 9);
});

// --- 上传与其它 -------------------------------------------------------------

test('uploadPayload：形状 {data, name}，data 为标准 base64', () => {
  const body = JSON.parse(uploadPayload(new Uint8Array([104, 105]), 'a.bin'));
  assert.deepEqual(body, { data: 'aGk=', name: 'a.bin' });
});

test('uploadPayload：文件名含引号/中文时被正确转义', () => {
  const body = JSON.parse(uploadPayload(new Uint8Array([1]), '他说"你好".txt'));
  assert.equal(body.name, '他说"你好".txt');
});

test('base64Of：空字节得到空串，非空走标准字母表', () => {
  assert.equal(base64Of(new Uint8Array(0)), '');
  assert.equal(base64Of(new Uint8Array([104, 105])), 'aGk=');
});

test('formatBytes：B / KiB / MiB 三档口径', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MiB');
  assert.equal(formatBytes(MAX_FILE_BYTES), '24.0 MiB');
});

test('bodyBytesOf：JSON 串转 UTF-8 字节往返一致（中文不乱码）', () => {
  const json = '{"text":"你好🌍"}';
  assert.equal(utf8Decode(bodyBytesOf(json)), json);
});

test('MAX_FILE_BYTES：文件上限 24 MiB（与图片上限分开）', () => {
  assert.equal(MAX_FILE_BYTES, 24 * 1024 * 1024);
});
