/**
 * 会话文件预览方式的分派 —— 移植自原工程 `data/PreviewKind.kt`（261 行）。
 *
 * 这条判断链整个是**纯逻辑**：只看文件名与 contentType（有字节时再看魔数），
 * 不碰任何 UI 与平台能力。所以放在 core 里，能被单测逐条钉住。
 *
 * 一条贯穿全文件的取向：**判据要能分清「认不出来」与「认成什么」**。
 * 扩展名不认识时退回 contentType，contentType 也认不出才落到 SOURCE/BINARY 兜底，
 * 而兜底那两档还允许被**魔数**升级成图片 —— 真实场景里 `screenshot` 这种没扩展名的文件
 * 确实可能是图片，而服务端给的 contentType 又常常不可靠。
 */

import { trimText } from './TextPredicates';

/** 一个文件该按哪种形态预览。 */
export enum PreviewKind {
  /** 渲染成 Markdown（标题、列表、表格、粗体）。 */
  MARKDOWN = 'MARKDOWN',
  /**
   * 结构化预览 HTML。
   *
   * 刻意**不**用 WebView 直接渲染：WebView 能跑任意 JS 与网络请求，而这里的内容来自
   * 会话里的任意文件 —— 那等于让一份不可信的文件在手机上拿到执行权。所以只提取结构
   * （标签、标题、段落、链接、表格），丢掉脚本与样式。
   */
  HTML = 'HTML',
  /** 源码视图：等宽字体，不做高亮但保留缩进与换行。 */
  SOURCE = 'SOURCE',
  /** 图片：解码后画出来，可双指缩放。 */
  IMAGE = 'IMAGE',
  /** PDF：逐页渲染。 */
  PDF = 'PDF',
  /** 二进制：不该按文本渲染，也没有可渲染的形态（压缩包、音视频、字体、db…）。 */
  BINARY = 'BINARY',
}

/**
 * 图片扩展名 —— 它们**从 BINARY_EXTENSIONS 里挪出来了**。
 *
 * 这条挪动不是洁癖：`previewKind` 里二进制判定在前，留在原集合里就永远命中
 * BINARY，图片分支一行都跑不到。
 */
const IMAGE_EXTENSIONS: Set<string> = new Set<string>([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'heic', 'heif', 'avif',
]);

/** PDF 扩展名，同上。 */
const PDF_EXTENSIONS: Set<string> = new Set<string>(['pdf']);

/** 二进制判定用：这些扩展名一律不走文本预览。 */
const BINARY_EXTENSIONS: Set<string> = new Set<string>([
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac',
  'mp4', 'mov', 'avi', 'mkv', 'webm',
  'so', 'dylib', 'dll', 'exe', 'bin', 'class', 'apk', 'aab',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'db', 'sqlite', 'sqlite3', 'wasm',
]);

/** Markdown 的扩展名（含常见的文档变体）。 */
const MARKDOWN_EXTENSIONS: Set<string> = new Set<string>(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

/** 直接当纯文本读的扩展名 —— 保留换行但不做 Markdown 解释。 */
const PLAIN_TEXT_EXTENSIONS: Set<string> = new Set<string>([
  'txt', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'env', 'properties', 'xml',
]);

/** 源码扩展名。 */
const SOURCE_EXTENSIONS: Set<string> = new Set<string>([
  'kt', 'kts', 'java', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go',
  'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'php', 'pl', 'lua', 'sh',
  'bash', 'zsh', 'fish', 'ps1', 'sql', 'r', 'm', 'mm', 'scala', 'dart', 'ex', 'exs',
  'gradle', 'cmake', 'make', 'dockerfile', 'vue', 'svelte', 'css', 'scss', 'less',
  'graphql', 'proto', 'tf', 'tfvars', 'patch', 'diff',
]);

/**
 * 取扩展名（小写，不含点）。
 *
 * 刻意**不**用「先 substringAfterLast('/') 再 substringAfterLast('.')」那一串链：
 * 后者在缺少分隔符时返回的是「整个原串」而不是空串，于是 `README.md` 这种**不含 `/`
 * 的裸文件名**会被当成「扩展名 = README.md」，一个都匹配不上，静默退化成源码预览
 * —— 而这正是用户看到的现象。这里用「最后一个点必须在最后一个斜杠之后」这个显式
 * 判据，没有歧义。
 */
function extensionOf(path: string): string {
  const name: string = path.substring(path.lastIndexOf('/') + 1);
  const dot: number = name.lastIndexOf('.');
  // 点在开头（`.gitignore`）不算扩展名；没有点、或点在末尾也不算。
  if (dot <= 0 || dot === name.length - 1) {
    return '';
  }
  return name.substring(dot + 1).toLowerCase();
}

function byContentType(contentType: string | null): PreviewKind {
  const type: string = trimText(contentType === null ? '' : contentType).toLowerCase();
  if (type.length === 0) {
    return PreviewKind.SOURCE;
  }
  if (type.startsWith('image/')) {
    return PreviewKind.IMAGE;
  }
  if (type === 'application/pdf') {
    return PreviewKind.PDF;
  }
  if (type.startsWith('audio/') || type.startsWith('video/')) {
    return PreviewKind.BINARY;
  }
  if (type.startsWith('text/')) {
    return PreviewKind.SOURCE;
  }
  if (type === 'application/json' || type === 'application/xml' || type === 'application/yaml') {
    return PreviewKind.SOURCE;
  }
  // application/octet-stream 等一律当二进制：按文本画出来只会是乱码。
  return PreviewKind.BINARY;
}

/**
 * 决定一个文件用哪种方式预览。
 *
 * 判据顺序是刻意的：
 * 1. **扩展名优先**。用户点开 `.md` 就是想看 Markdown，不该被 `contentType` 带走
 *    —— 浏览器给的 MIME 在本地机器上五花八门（`text/x-markdown`、`text/plain`、
 *    空串都见过），拿它当主判据会得到「有时渲染有时不渲染」的最坏体验。
 * 2. 扩展名不认识时**退回 contentType**，这样服务端返回 `text/html` 的无名文件
 *    至少不会被当成源码。
 * 3. 二进制**永远**不走文本预览，不管 MIME 说什么 ——
 *    `application/octet-stream` 配一个 `.png` 的文件是常态，而把二进制当 UTF-8
 *    解出来只会得到一堆替换字符。
 *
 * @param fileName 完整文件名或路径；取最后一段的扩展名，**大小写不敏感**。
 * @param contentType 服务端给的 MIME，可为 null。
 */
export function previewKind(fileName: string, contentType: string | null = null): PreviewKind {
  const extension: string = extensionOf(fileName);
  if (extension.length === 0) {
    return byContentType(contentType);
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return PreviewKind.IMAGE;
  }
  if (PDF_EXTENSIONS.has(extension)) {
    return PreviewKind.PDF;
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return PreviewKind.BINARY;
  }
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return PreviewKind.MARKDOWN;
  }
  if (extension === 'html' || extension === 'htm' || extension === 'xhtml') {
    return PreviewKind.HTML;
  }
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    return PreviewKind.SOURCE;
  }
  if (SOURCE_EXTENSIONS.has(extension)) {
    return PreviewKind.SOURCE;
  }
  return byContentType(contentType);
}

/** 认得出来的图片格式。只用于提示与测试，不参与解码本身。 */
export enum ImageFormat {
  PNG = 'PNG',
  JPEG = 'JPEG',
  GIF = 'GIF',
  WEBP = 'WEBP',
  BMP = 'BMP',
  HEIF = 'HEIF',
  AVIF = 'AVIF',
}

const BMP_DIB_HEADER_SIZES: Set<number> = new Set<number>([12, 40, 52, 56, 64, 108, 124]);

const HEIF_BRANDS: Set<string> = new Set<string>([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1',
]);

/**
 * 按**魔数**认图片格式，不认扩展名也不认 MIME。
 *
 * 全部取头部固定偏移，长度不够一律 null（半截文件不能瞎猜）。两个刻意的收紧：
 * - BMP 要求「`BM` + 偏移 10 处的 DIB 头长度属于已知集合」——
 *   只认两个字母会把任何以「BM…」开头的文本误判成图片，这个偏移是廉价且有效的证伪。
 * - HEIF / AVIF 要求 `ftyp` 主品牌在已知集合里，而不是「有 ftyp 就算图」。
 *
 * 认不出的（TIFF、SVG、还有别的一堆）返回 null，交回原有判据 —— 宁可退回二进制，
 * 也不要把一份文本当图片解出来。
 */
export function sniffImageFormat(bytes: Uint8Array | null): ImageFormat | null {
  if (bytes === null) {
    return null;
  }
  const data: Uint8Array = bytes;
  const byte = (index: number): number => data[index] & 0xFF;
  const ascii = (from: number, text: string): boolean => {
    if (data.length < from + text.length) {
      return false;
    }
    for (let i = 0; i < text.length; i++) {
      if (byte(from + i) !== text.charCodeAt(i)) {
        return false;
      }
    }
    return true;
  };

  if (data.length >= 8 && byte(0) === 0x89 && ascii(1, 'PNG')
    && byte(4) === 0x0D && byte(5) === 0x0A && byte(6) === 0x1A && byte(7) === 0x0A) {
    return ImageFormat.PNG;
  }
  if (data.length >= 3 && byte(0) === 0xFF && byte(1) === 0xD8 && byte(2) === 0xFF) {
    return ImageFormat.JPEG;
  }
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) {
    return ImageFormat.GIF;
  }
  if (data.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    return ImageFormat.WEBP;
  }
  if (data.length >= 14 && byte(0) === 0x42 && byte(1) === 0x4D) {
    // 小端 32 位：BMP 文件头之后紧跟的 DIB 头长度。
    const dib: number = byte(10) | (byte(11) << 8) | (byte(12) << 16) | (byte(13) << 24);
    if (BMP_DIB_HEADER_SIZES.has(dib)) {
      return ImageFormat.BMP;
    }
  }
  if (data.length >= 12 && ascii(4, 'ftyp')) {
    let brand: string = '';
    for (let i = 8; i < 12; i++) {
      brand += String.fromCharCode(byte(i));
    }
    brand = brand.toLowerCase();
    if (brand === 'avif' || brand === 'avis') {
      return ImageFormat.AVIF;
    }
    if (HEIF_BRANDS.has(brand)) {
      return ImageFormat.HEIF;
    }
  }
  return null;
}

/**
 * 有字节时更准的分派：扩展名与 MIME 都可能撒谎，**魔数不会**。
 *
 * 只做「升级」：名字或 MIME 已经明确说是图片 / PDF 就照旧；否则如果头部字节像图片，
 * 就按图片渲染。解决的是真实场景 —— 服务端给的 `contentType` 不可靠（项目里已经
 * 因此吃过亏），而 `screenshot` 这种**没有扩展名**的文件也确实可能是图片。
 *
 * @param bytes 还没读到字节时传 null，此时等价于 `previewKind`。
 */
export function previewKindOf(fileName: string, contentType: string | null,
  bytes: Uint8Array | null): PreviewKind {
  const byName: PreviewKind = previewKind(fileName, contentType);
  // 名字明确说是 Markdown / HTML 就尊重名字：那是用户点开它的意图，不该被字节带走。
  if (byName === PreviewKind.MARKDOWN || byName === PreviewKind.HTML) {
    return byName;
  }
  // 剩下两种才接受「升级」：SOURCE 是「扩展名与 MIME 都认不出来」的兜底，
  // BINARY 是「已知是二进制但不知道是什么」—— 一张没有扩展名的截图正好落在这两档。
  if (byName === PreviewKind.SOURCE || byName === PreviewKind.BINARY) {
    return sniffImageFormat(bytes) === null ? byName : PreviewKind.IMAGE;
  }
  return byName;
}

// ── 预览上限：超了就不硬啃，改成「文件信息 + 明确提示 + 下载出路」 ──

/** 图片预览的字节上限（24 MiB）：解码前要把整份字节读进内存，必须有闸。 */
export const PREVIEW_IMAGE_MAX_BYTES: number = 24 * 1024 * 1024;

/** PDF 预览的字节上限（32 MiB），理由同上。 */
export const PREVIEW_PDF_MAX_BYTES: number = 32 * 1024 * 1024;

/** PDF 最多可翻的页数：几百页的标书没必要在手机上全渲染一遍。 */
export const PREVIEW_PDF_MAX_PAGES: number = 100;

/**
 * 图片 / PDF 的字节上限；其他类型返回 null。
 *
 * 抽成函数是为了**只有一份真值**：加载路径与提示文案都从它取数，
 * 改成同一条闸只需改一处。
 */
export function binaryPreviewByteLimit(kind: PreviewKind): number | null {
  if (kind === PreviewKind.IMAGE) {
    return PREVIEW_IMAGE_MAX_BYTES;
  }
  if (kind === PreviewKind.PDF) {
    return PREVIEW_PDF_MAX_BYTES;
  }
  return null;
}

/**
 * 图片解码后的像素上限（12 MP ≈ 48 MiB 的 ARGB_8888）。
 *
 * 为什么按像素而不是按字节：20 MB 的 PNG 可能只有 1000×1000（没压缩好），
 * 而 3 MB 的 JPEG 可能是 8000×6000（48 MP，直接解码就 OOM）。
 * 用 `sampleSizeFor` 先按 2 的幂缩小再解码，内存与观感都能接受。
 */
export const PREVIEW_IMAGE_MAX_PIXELS: number = 12000000;

/**
 * 算出图片解码的采样倍率：2 的幂，且解码后的像素数不超过 `maxPixels`。
 *
 * 纯函数，单测钉住。平台解码器要的就是 2 的幂（别的值会被它向下取整到最近的 2 的幂），
 * 自己算是为了不让「传 3 实际按 2 走」这种意外留在暗处。
 */
export function sampleSizeFor(width: number, height: number,
  maxPixels: number = PREVIEW_IMAGE_MAX_PIXELS): number {
  if (width <= 0 || height <= 0) {
    return 1;
  }
  let sample: number = 1;
  while (Math.floor(width / sample) * Math.floor(height / sample) > maxPixels) {
    sample *= 2;
  }
  return sample;
}
