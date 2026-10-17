/**
 * 「把消息里的图片存出去」这一步的**命名判据** —— 移植自源工程
 * `ui/chat/ChatImageViewer.kt` 的 `galleryFileName` / `IMAGE_FILE_EXTENSIONS`。
 *
 * ## 为什么单独成文件、并且只留命名这一半
 *
 * 源工程那一半（`mimeTypeOf` + `MediaStore` 写入 + `IS_PENDING` + 半截文件回滚）
 * 是为安卓的**相册写入**服务的；鸿蒙这边的落点是 `platform/Pickers.ets` 的
 * `saveBytes`（系统「保存」面板，**零权限**），写入与回滚由那一条路自己负责。
 * 能搬过来的、且值得单测钉住的，就是「该叫什么名字」这一条纯函数。
 *
 * ## 为什么扩展名要用**魔数**推、而不是照抄原文件名
 *
 * 会话里的图片经常是模型或工具落下的临时文件（`screenshot`、`img_0`），要么没有扩展名，
 * 要么扩展名是错的。存到用户能看到的地方时，一个错的扩展名会让相册/预览器直接打不开 ——
 * 所以先用 `sniffImageFormat` 认格式补扩展名，**已经带了合法图片扩展名时才尊重原名**
 * （用户自己起的名字不该被改）。
 */

import { ImageFormat, sniffImageFormat } from './PreviewKind';

/** 认得出格式时给扩展名；认不出（TIFF / SVG 之类）返回 null，此时不动原文件名。 */
export function extensionOfFormat(format: ImageFormat | null): string | null {
  if (format === ImageFormat.PNG) {
    return 'png';
  }
  if (format === ImageFormat.JPEG) {
    return 'jpg';
  }
  if (format === ImageFormat.GIF) {
    return 'gif';
  }
  if (format === ImageFormat.WEBP) {
    return 'webp';
  }
  if (format === ImageFormat.BMP) {
    return 'bmp';
  }
  if (format === ImageFormat.HEIF) {
    return 'heic';
  }
  if (format === ImageFormat.AVIF) {
    return 'avif';
  }
  // 认不出来的（TIFF、SVG、还有别的一堆）：宁可不动原名，也不要塞一个错类型。
  return null;
}

/**
 * 已经在名字里的、**合法的**图片扩展名。带了这些就保留原名，不再补后缀。
 *
 * 集合里放了 `heif`：源工程的 `extensionOfFormat` 只产出 `heic`，但 `sniffImageFormat`
 * 认得 `heif` 这个品牌名，用户手里也可能真的有 `.heif` —— 不列进来的话，
 * 一个 `.heif` 文件会被存成 `.heif.heic`（源工程同样如此，这里刻意改对，
 * 代价只是多一条集合成员）。
 */
const IMAGE_FILE_EXTENSIONS: Set<string> = new Set<string>([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif',
]);

/**
 * 保存时建议的文件名。
 *
 * - 取路径末段（服务端可能给绝对路径），空则回落 `image`；
 * - 名字已带合法图片扩展名 → 原样返回（**不覆盖用户/上游起的名字**）；
 * - 否则按魔数补扩展名；连格式都认不出就原样返回。
 *
 * 传给系统保存面板后**用户可以改名** —— 这里给的只是默认值，所以它偏保守就好，
 * 不必强行纠正。
 */
export function galleryFileName(name: string | null, bytes: Uint8Array | null): string {
  const raw: string = name === null ? '' : name;
  const slash: number = raw.lastIndexOf('/');
  const tail: string = (slash < 0 ? raw : raw.substring(slash + 1)).trim();
  const base: string = tail.length === 0 ? 'image' : tail;

  const extension: string | null = extensionOfFormat(sniffImageFormat(bytes));
  if (extension === null) {
    return base;
  }
  const dot: number = base.lastIndexOf('.');
  const existing: string = (dot < 0 ? '' : base.substring(dot + 1)).toLowerCase();
  return IMAGE_FILE_EXTENSIONS.has(existing) ? base : `${base}.${extension}`;
}
