/**
 * 图片字节 → 可渲染像素图 —— 平台层。
 *
 * 源工程用 Android 的 `BitmapFactory.decodeByteArray`；鸿蒙这边没有那个名字，
 * 对应能力是 `@ohos.multimedia.image` 的 `ImageSource` + `createPixelMapSync`。
 * ArkUI 的 `Image()` **不接受原始字节**（只认 PixelMap / 资源字符串 / DrawableDescriptor），
 * 所以这一步是必经之路，不能省。
 *
 * ## 为什么在这里限尺寸
 *
 * 会话历史里的原图可能很大（用户贴过 4K 截图）。`Image` 组件显示的尺寸通常是
 * 两三厘米见方，按原始像素解码等于把几十 MB 的位置全占上。所以这里先读图片信息，
 * 按「保持长宽比、长边不超过 [MAX_DECODE_EDGE_PX]」算出目标尺寸再解码 ——
 * 对应源工程的 `sampleSizeFor`（安卓那边是整数采样，这里是按精确尺寸解码，效果一样）。
 *
 * ## 为什么返回 null 而不是抛错
 *
 * 字节取到了但不是有效图片（服务端索引坏了、内容被截断）是一种**正常**结果，
 * 界面要把它显示成「这张图片无法显示」而不是让整条消息渲染失败。
 * 所以解码失败一律返回 null，由调用方决定文案。
 */

import { image } from '@kit.ImageKit';

/**
 * 解码后长边的像素上限。
 *
 * 取 1024 的理由：聊天里的图片显示宽度上限是 260vp，按 3 倍密度算约 780px；
 * 留到 1024 是为了让用户点开看细节时不至于糊，同时把内存控制在单张 4 MB 上下
 * （RGBA 1024×1024×4）。再大一档（2048）解码时间会明显变长，翻长会话列表时会卡。
 */
const MAX_DECODE_EDGE_PX: number = 1024;

/** 目标尺寸：保持长宽比缩到长边不超过上限；本来就小就原样。 */
function targetSize(width: number, height: number): image.Size {
  const edge: number = Math.max(width, height);
  if (edge <= MAX_DECODE_EDGE_PX || edge <= 0) {
    return { width: width, height: height };
  }
  const scale: number = MAX_DECODE_EDGE_PX / edge;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * 把字节解成 PixelMap。
 *
 * 三步各自的失败点不同，但对外只有「成功 / 不可解码」两种结果：
 * 1. `createImageSource` —— 字节不是任何已知图片格式；
 * 2. `getImageInfoSync` —— 能认出容器但读不出尺寸（截断的文件经常是这样）；
 * 3. `createPixelMapSync` —— 解码本身失败（损坏的数据）。
 */
export function decodeImageSync(bytes: Uint8Array | null): image.PixelMap | null {
  if (bytes === null || bytes.byteLength === 0) {
    return null;
  }
  let source: image.ImageSource | null = null;
  try {
    // 必须只把这一段字节交给解码器：`bytes` 可能是更大缓冲上的一个视图，
    // 直接把 `.buffer` 交出去会把视图之外的内容也一起喂进去（图片头对不上就解不出来）。
    const exact: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    source = image.createImageSource(exact);
    const info: image.ImageInfo = source.getImageInfoSync();
    const target: image.Size = targetSize(info.size.width, info.size.height);
    return source.createPixelMapSync({ desiredSize: target });
  } catch (e) {
    return null;
  } finally {
    if (source !== null) {
      try {
        source.release();
      } catch (e) {
        // 释放失败无影响：PixelMap 已经独立于 source。
      }
    }
  }
}

/** 字节的指纹，用来判断「同一个附件 id 的字节变了没有」，避免重复解码。 */
export function bytesFingerprint(bytes: Uint8Array | null): string {
  if (bytes === null) {
    return '';
  }
  return `${bytes.byteLength}`;
}
