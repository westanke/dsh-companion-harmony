/**
 * 附件选择器 —— 平台层。源工程对应 Android 的 `ActivityResultContracts.PickVisualMedia`
 * （相册）与 `OpenDocument`（文件）。鸿蒙这边没有那个 Activity 契约，对应能力是
 * **系统选择器**：`photoAccessHelper.PhotoViewPicker`（图库）与 `picker.DocumentViewPicker`（文件）。
 *
 * ## 为什么放在平台层而不是 core
 *
 * 选择器是纯平台能力（要 Context、要弹系统 UI、要读 picker 授权过的 URI），
 * core 一行都碰不了；但**大小上限的判据**（`MAX_IMAGE_BYTES` / `MAX_FILE_BYTES`）
 * 属于 core 的业务规则，已经在 `HarnessViewModel.attachImage/attachFile` 里。
 *
 * 这里只多一层**早退保护**：本函数在把字节读进内存**之前**先看 `statSync().size`，
 * 超限就直接返回 `TOO_LARGE` 且不读盘。理由很实际 —— 用户在相册里手一滑选了一张
 * 200 MB 的原图，如果在 UI 层读完再交给 vm 判超限，那一刻的内存峰值就已经付掉了。
 * vm 里的那道判据不能省（它是契约的一部分），这里这道是防事故的。
 *
 * ## 权限
 *
 * 两个选择器都**不需要申请任何权限**：它们返回的是系统组件授予的临时 URI
 * （`file://docs/...` / `datashare://...`），`fileIo` 能直接按该 URI 打开。
 * 这也是为什么本文件没有 `requestPermissionsFromUser` —— 与源工程一致（安卓那边照片选择
 * 同样不需要 READ_MEDIA_IMAGES）。
 *
 * ## 取消与失败的区分
 *
 * 用户点「取消」会让 `select()` 抛错，而它与「读不出来」在界面上是两回事：
 * 前者什么都不该说，后者必须给一句「换一个再试」。所以返回的是 `PickResult`，
 * 用 `CANCELLED` 把这件事显式表达出来，而不是靠「返回 null」让调用方猜。
 */

import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';

/** 读出来的一个文件（已进内存）。 */
export class PickedFile {
  /** 文件名（带扩展名），用于界面显示与附件命名。 */
  name: string;
  bytes: Uint8Array;
  /** 由扩展名推出来的媒体类型；推不出来时给 `application/octet-stream`。 */
  mediaType: string;

  constructor(name: string, bytes: Uint8Array, mediaType: string) {
    this.name = name;
    this.bytes = bytes;
    this.mediaType = mediaType;
  }
}

/**
 * 失败原因。`CANCELLED` 单独一档：用户主动取消不是错误，界面不该弹任何提示。
 */
export enum PickFailureKind {
  CANCELLED = 'CANCELLED',
  READ_FAILED = 'READ_FAILED',
  TOO_LARGE = 'TOO_LARGE',
}

/**
 * 选择结果。两个字段**必然恰好有一个非 null**：要么拿到文件，要么给出原因。
 *
 * `limitBytes` 只在 `TOO_LARGE` 时用于文案（「上限 4 MiB」），所以由调用方传进来、
 * 原样带回去，本文件不自己算这个数。
 */
export class PickResult {
  file: PickedFile | null;
  failure: PickFailureKind | null;
  limitBytes: number;

  constructor(file: PickedFile | null, failure: PickFailureKind | null, limitBytes: number) {
    this.file = file;
    this.failure = failure;
    this.limitBytes = limitBytes;
  }

  static ok(file: PickedFile): PickResult {
    return new PickResult(file, null, 0);
  }

  static cancelled(limitBytes: number): PickResult {
    return new PickResult(null, PickFailureKind.CANCELLED, limitBytes);
  }

  static failed(kind: PickFailureKind, limitBytes: number): PickResult {
    return new PickResult(null, kind, limitBytes);
  }
}

/**
 * 保存（下载）的结果。
 *
 * 用枚举而不是「有没有异常」：**取消**与**写失败**对界面是两种完全不同的处置
 * （前者静默、后者要提示），混成一个布尔量就会在用户按了取消时弹一句「保存失败」。
 */
export enum SaveOutcome {
  SAVED = 'SAVED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

/** 扩展名 → 媒体类型。只列真正会用到的那些；其余给通用二进制。 */
function mediaTypeOf(name: string): string {
  const dot: number = name.lastIndexOf('.');
  const ext: string = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  if (ext === 'png') {
    return 'image/png';
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'gif') {
    return 'image/gif';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'bmp') {
    return 'image/bmp';
  }
  if (ext === 'heic' || ext === 'heif') {
    return 'image/heic';
  }
  if (ext === 'pdf') {
    return 'application/pdf';
  }
  if (ext === 'json') {
    return 'application/json';
  }
  if (ext === 'txt' || ext === 'log' || ext === 'md') {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

/** URI 末段当文件名；去掉查询串（picker 给的 URI 可能带 `?` 参数）。 */
function nameOfUri(uri: string): string {
  let clean: string = uri;
  const question: number = clean.indexOf('?');
  if (question >= 0) {
    clean = clean.substring(0, question);
  }
  const slash: number = clean.lastIndexOf('/');
  const name: string = slash < 0 ? clean : clean.substring(slash + 1);
  return name.length > 0 ? decodeURIComponent(name) : 'attachment';
}

/**
 * 按 URI 读文件。
 *
 * 三步都在 `try` 里：`openSync` 可能因为授权过期/文件被删而失败，`statSync` 可能失败，
 * `readSync` 读到的字节数**可能小于**声明大小（文件正在被写）。所以最终只取真正读到的
 * 那一段 —— 拿一个尾部全是 0 的 buffer 去当图片，解码必然失败，而失败信息会指向
 * 「图片坏了」这个错误结论。
 */
function readUri(uri: string, maxBytes: number): PickResult {
  let file: fs.File | null = null;
  try {
    file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    const size: number = fs.statSync(file.fd).size;
    if (size > maxBytes) {
      return PickResult.failed(PickFailureKind.TOO_LARGE, maxBytes);
    }
    const buffer: ArrayBuffer = new ArrayBuffer(size);
    const read: number = fs.readSync(file.fd, buffer);
    const view: Uint8Array = new Uint8Array(buffer).slice(0, read);
    const name: string = nameOfUri(uri);
    return PickResult.ok(new PickedFile(name, view, mediaTypeOf(name)));
  } catch (e) {
    return PickResult.failed(PickFailureKind.READ_FAILED, maxBytes);
  } finally {
    if (file !== null) {
      try {
        fs.closeSync(file);
      } catch (e) {
        // 关不掉就算了：选择器给的是临时 fd，进程退出时由系统回收。
      }
    }
  }
}

/** 从系统错误里认出「用户取消」。各家 picker 取消时的 code 不同，所以按消息匹配。 */
function isCancelled(e: Object): boolean {
  const text: string = `${e}`.toLowerCase();
  return text.includes('cancel') || text.includes('user cancel');
}

/**
 * 从图库里选一张图。
 *
 * 用 `photoAccessHelper.PhotoViewPicker` 而不是 `@ohos.file.picker` 里的同名类 ——
 * 后者自 API 12 起已废弃，前者是官方推荐的替代；两者行为一致（都弹系统图库、
 * 都不需要权限、取消都抛错），但前者不会被将来的 SDK 移除。
 */
export async function pickImage(context: common.Context, maxBytes: number): Promise<PickResult> {
  let uri: string | null = null;
  try {
    const options: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
    options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
    options.maxSelectNumber = 1;
    const viewPicker: photoAccessHelper.PhotoViewPicker = new photoAccessHelper.PhotoViewPicker();
    const result: photoAccessHelper.PhotoSelectResult = await viewPicker.select(options);
    if (result.photoUris.length === 0) {
      return PickResult.cancelled(maxBytes);
    }
    uri = result.photoUris[0];
  } catch (e) {
    if (isCancelled(e as Object)) {
      return PickResult.cancelled(maxBytes);
    }
    return PickResult.failed(PickFailureKind.READ_FAILED, maxBytes);
  }
  return readUri(uri, maxBytes);
}

/**
 * 从文件管理器里选一个文件。
 *
 * `fileSuffixFilters` 留空 = 不过滤类型（源工程的文件选择也是全类型：会话里要发的东西
 * 是日志、补丁、压缩包，猜不准）。`maxSelectNumber = 1` 与源工程一致 ——
 * 多选会带来「一次上传几个、失败了几条怎么提示」这一整套问题，不在本次范围内。
 */
export async function pickFile(context: common.Context, maxBytes: number): Promise<PickResult> {
  let uri: string | null = null;
  try {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    const uris: string[] = await documentPicker.select(options);
    if (uris.length === 0) {
      return PickResult.cancelled(maxBytes);
    }
    uri = uris[0];
  } catch (e) {
    if (isCancelled(e as Object)) {
      return PickResult.cancelled(maxBytes);
    }
    return PickResult.failed(PickFailureKind.READ_FAILED, maxBytes);
  }
  return readUri(uri, maxBytes);
}

/**
 * 把字节写到用户指定的位置（对位源工程的「下载」：转成 `Uri` 再交给系统处理）。
 *
 * 三处与源工程一致：**取消不是错误**（返回 `CANCELLED` 而不是失败，界面不弹提示）、
 * **先让用户选位置再写**（`DocumentViewPicker.save` 会弹系统保存面板，用户可改文件名）、
 * **失败只回报不抛错**（调用方拿到 `FAILED` 去弹提示）。
 *
 * 与 `pickFile` 一样零权限：保存面板返回的是一个授权过的 URI，`fs.openSync` 可直接写。
 * 文件名由调用方给（通常就是原文件名），但**用户可以改** —— 面板里那个才是最终名字。
 */
export async function saveBytes(context: common.Context, suggestedName: string,
  bytes: Uint8Array): Promise<SaveOutcome> {
  let uri: string | null = null;
  try {
    const options: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
    options.newFileNames = [suggestedName];
    const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    const uris: string[] = await documentPicker.save(options);
    if (uris.length === 0) {
      return SaveOutcome.CANCELLED;
    }
    uri = uris[0];
  } catch (e) {
    return isCancelled(e as Object) ? SaveOutcome.CANCELLED : SaveOutcome.FAILED;
  }

  let file: fs.File | null = null;
  try {
    file = fs.openSync(uri, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
    // 只把 `bytes` 的**那一段**写出去（`byteOffset` 不为 0 时直接交 `buffer` 会多写前面的字节）。
    fs.writeSync(file.fd, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return SaveOutcome.SAVED;
  } catch (e) {
    return SaveOutcome.FAILED;
  } finally {
    if (file !== null) {
      try {
        fs.closeSync(file);
      } catch (e) {
        // 关不掉就算了：临时 fd 会随进程回收。
      }
    }
  }
}
