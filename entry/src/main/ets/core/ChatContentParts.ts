/**
 * 发消息体的组装与资源上限 —— 移植自原工程 `data/ChatContentParts.kt`。
 *
 * 为什么这段逻辑不写在 `DshClient` 里：它是**纯逻辑**（没有网络、没有平台 API），
 * 而它恰好踩点最多 —— 旧格式兼容、空内容拒绝、图片上限、base64 口径。放在能跑单测的
 * 模块里，「发出去的东西长什么样」才可以被钉死，而不是靠手点验证。
 *
 * 序列化的两条硬规则：
 * 1. **只有纯文本才走旧格式** `{"text": "..."}`。服务端两种都吃，但旧格式向后兼容已发布的
 *    老插件，能不升级就不升；一旦带附件就必须用 `{"content": [...]}`。
 * 2. 编码 `PromptPart` 时**打开 `encodeDefaults`**。默认会省略等于默认值的字段 ——
 *    那样 `mediaType = "image/png"` 会被悄悄丢掉，服务端收到一个没有 mediaType 的 image
 *    part。这是个安静的坑，所以 `PromptPart.toMap()` 显式保证「形态内字段一律写出」，
 *    只有 `name` 为 null 时才不写（对应 `explicitNulls = false`）。
 */

import { PromptPart } from './Models';
import { base64Encode, utf8Encode } from './Codec';

/**
 * 单张**原图**的字节上限。
 *
 * 限制的是原始字节而不是 base64 长度：base64 会膨胀约 33%，所以 8 MiB 原图在请求体里约
 * 10.7 MiB。先在这里拦下来，用户拿到的是「先压缩再试」这种能照做的提示，而不是等一个 413。
 */
export const MAX_IMAGE_BYTES: number = 8 * 1024 * 1024;

/**
 * 单个**文件附件**的字节上限。
 *
 * 文件要先整段读进内存再 base64 成 JSON，没有上限时一个几百 MB 的文件会在手机上直接 OOM
 * ——那比「文件太大」糟糕得多。24 MiB 约对应 32 MiB 的请求体，是低端机也能扛住的量级。
 */
export const MAX_FILE_BYTES: number = 24 * 1024 * 1024;

/** 超过上限时抛出的错误码（与上游 message 口径一致，调用方按 message 判定）。 */
export const ERROR_IMAGE_TOO_LARGE: string = 'IMAGE_TOO_LARGE';
export const ERROR_EMPTY_CONTENT: string = 'EMPTY_CONTENT';

/**
 * 「按块读」的最小抽象（替代 Java 的 `InputStream`）。
 * 平台层用 `@ohos.file.fs` 的流实现它；单测里换成内存字节序列。
 * 返回本次读到的字节数；已到末尾返回 -1。
 */
export interface ByteSource {
  read(buffer: Uint8Array, offset: number, length: number): number;
}

/** 标准 base64（带 `=` 填充，**不是** URL-safe）。 */
export function base64Of(bytes: Uint8Array): string {
  return base64Encode(bytes, false, true);
}

/**
 * 构造一个内联图片 part。
 *
 * 超限直接抛错（`IMAGE_TOO_LARGE`），而不是造一个超大请求体让服务端去拒绝 ——
 * 那时用户已经等了一轮上传。
 */
export function imagePart(mediaType: string, bytes: Uint8Array, name: string | null = null): PromptPart {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(ERROR_IMAGE_TOO_LARGE);
  }
  const trimmed: string = name === null ? '' : name.trim();
  return PromptPart.image(mediaType, base64Of(bytes), trimmed.length > 0 ? name : null);
}

/**
 * 读进内存，但**最多读 limit + 1 字节**。
 *
 * 为什么不能直接读到底：选择器返回的大小可能是 -1（内容提供者不肯说大小），于是一个几百 MB
 * 的文件会在判断「超限」之前就把内存吃穿。多读的那一个字节是刻意的：它让调用方能区分
 * - 返回值长度 `<= limit` —— 文件完整读完了，放行；
 * - 返回值长度 `> limit` —— 还没读完就停手了，**必须拒绝**。
 * 没有这一字节，一个正好卡在缓冲边界上的超大文件会被当成「读完的完整文件」发出去。
 */
export function readAtMost(limit: number, input: ByteSource, chunkSize: number = 64 * 1024): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total: number = 0;
  const buffer: Uint8Array = new Uint8Array(chunkSize);
  while (total <= limit) {
    const want: number = Math.min(chunkSize, limit + 1 - total);
    if (want <= 0) {
      break;
    }
    const read: number = input.read(buffer, 0, want);
    if (read <= 0) {
      break;
    }
    const chunk: Uint8Array = new Uint8Array(read);
    for (let i = 0; i < read; i++) {
      chunk[i] = buffer[i];
    }
    chunks.push(chunk);
    total += read;
  }
  const out: Uint8Array = new Uint8Array(total);
  let offset: number = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk: Uint8Array = chunks[i];
    for (let j = 0; j < chunk.length; j++) {
      out[offset + j] = chunk[j];
    }
    offset += chunk.length;
  }
  return out;
}

/** `POST chat/sessions/:id/attachments` 的请求体：`{"data":"<base64>","name":"..."}`。 */
export function uploadPayload(bytes: Uint8Array, name: string): string {
  return `{"data":${JSON.stringify(base64Of(bytes))},"name":${JSON.stringify(name)}}`;
}

/**
 * 组装发消息的请求体。
 *
 * - 只有单个非空 text part → **旧格式**（`text` 键），保持与老插件、老版本的兼容；
 * - 其他任何组合 → `content` 数组；
 * - 去掉空白 text part 之后什么都不剩（例如只发了一串空格）→ 抛 `EMPTY_CONTENT`，
 *   宁可本地报错，也不要发一个服务端必然拒绝的空 prompt。
 */
export function messageBody(parts: PromptPart[], mode: string, clientTimeZone: string,
                            clientRequestId: string): string {
  const content: PromptPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part: PromptPart = parts[i];
    if (part.type === PromptPart.TYPE_TEXT && part.text.trim().length === 0) {
      continue;
    }
    content.push(part);
  }
  if (content.length === 0) {
    throw new Error(ERROR_EMPTY_CONTENT);
  }
  const singleText: string | null = content.length === 1 && content[0].type === PromptPart.TYPE_TEXT
    ? content[0].text : null;
  const head: string = singleText !== null
    ? `{"text":${JSON.stringify(singleText)}`
    : `{"content":${JSON.stringify(PromptPart.toMapArray(content))}`;
  return `${head},"mode":${JSON.stringify(mode)},"clientTimeZone":${JSON.stringify(clientTimeZone)}`
    + `,"clientRequestId":${JSON.stringify(clientRequestId)}}`;
}

/**
 * 图片的 mediaType。
 *
 * 系统选择器给的 MIME 是首选；拿不到时就按扩展名推，最后兜底 `image/png` ——
 * 能走到这里的文件都是从图片选择器里挑出来的，确实是一张图，缺一个精确的 MIME
 * 不该让用户发不出去。
 */
export function imageMediaType(contentType: string | null, fileName: string): string {
  const declared: string = contentType === null ? '' : contentType.trim().toLowerCase();
  if (declared.startsWith('image/')) {
    return declared;
  }
  const dot: number = fileName.lastIndexOf('.');
  const ext: string = dot >= 0 ? fileName.substring(dot + 1).toLowerCase() : '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/png';
}

/** 附件条上显示的体积，与「文件」页的口径一致（KiB / MiB）。 */
export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KiB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

/** 把字节编码成请求体（供平台层直接喂给 HTTP 客户端）。 */
export function bodyBytesOf(json: string): Uint8Array {
  return utf8Encode(json);
}
