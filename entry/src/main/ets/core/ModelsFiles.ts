/**
 * 线上模型 —— **文件与目录**：`FileEntry`、`DirectoryPage`、`ResolvedPath`、`TrashEntry`、`FileContent`。
 *
 * 面向服务端线上模型的**三条规矩**（字段一律给默认值 / 请求体省略 null / 判别联合按 type 分派）
 * 写在 `Models.ts` 的文件头 —— 那是本模块的索引。拆分的来龙去脉也见那里。
 */

import { JsonAccess, JsonMap } from './JsonAccess';

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

export class FileEntry {
  name: string = '';
  path: string = '';
  /** `file` 或 `directory`；未知取值由界面兜底，不在这里抛错。 */
  kind: string = '';
  size: number = 0;
  modifiedAt: number = 0;
  writable: boolean = false;

  isDirectory(): boolean {
    return this.kind === 'directory';
  }

  /**
   * 只改 `size` 的副本。
   *
   * 为 `HarnessViewModel.replaceSelected` 补：上传替换成功后要把本地这条条目的大小
   * 改成刚写出去的长度（对应 Kotlin `document.entry.copy(size = length)`），
   * 好让面板按新尺寸重新判「要不要跳过预览」。
   */
  withSize(size: number): FileEntry {
    const v: FileEntry = new FileEntry();
    v.name = this.name;
    v.path = this.path;
    v.kind = this.kind;
    v.size = size;
    v.modifiedAt = this.modifiedAt;
    v.writable = this.writable;
    return v;
  }

  static fromJson(map: JsonMap | null): FileEntry {
    const v: FileEntry = new FileEntry();
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.path = JsonAccess.str(map, 'path') ?? '';
    v.kind = JsonAccess.str(map, 'kind') ?? '';
    v.size = JsonAccess.num(map, 'size') ?? 0;
    v.modifiedAt = JsonAccess.num(map, 'modifiedAt') ?? 0;
    v.writable = JsonAccess.bool(map, 'writable') ?? false;
    return v;
  }
}

export class DirectoryPage {
  path: string = '';
  entries: FileEntry[] = [];
  nextCursor: string | null = null;

  /**
   * 只改「条目列表 + 下一页游标」的副本。
   *
   * 为 `HarnessViewModel.loadNextDirectoryPage` 补：对应 Kotlin
   * `current.copy(entries = 合并去重后的, nextCursor = next.nextCursor)` ——
   * 翻页只追加条目、换游标，`path` 等字段原样保留。
   */
  withMerged(entries: FileEntry[], nextCursor: string | null): DirectoryPage {
    const v: DirectoryPage = new DirectoryPage();
    v.path = this.path;
    v.entries = entries;
    v.nextCursor = nextCursor;
    return v;
  }

  static fromJson(map: JsonMap | null): DirectoryPage {
    const v: DirectoryPage = new DirectoryPage();
    v.path = JsonAccess.str(map, 'path') ?? '';
    const raw: JsonMap[] = JsonAccess.objArr(map, 'entries');
    for (let i = 0; i < raw.length; i++) {
      v.entries.push(FileEntry.fromJson(raw[i]));
    }
    v.nextCursor = JsonAccess.str(map, 'nextCursor');
    return v;
  }
}

/**
 * `GET roots/resolve?path=<绝对路径>` 的响应：把一个**服务器绝对路径**翻译成
 * 「它属于哪个授权根 + 相对路径」。
 *
 * 为什么需要服务端代劳：会话事件里的路径是绝对路径，而 `roots` 刻意不返回根的绝对路径，
 * 客户端没有足够信息自己完成映射；把绝对路径直接喂给 `roots/:id/content` 又会被
 * `PATH_INVALID` 拒绝。响应里**依然不含根的绝对路径**，安全性没有被削弱。
 *
 * `size` / `contentType` 在服务端是 `number | null` / `string | null`：目录没有大小和内容
 * 类型，服务端会**显式发送 `null`**，所以必须可空。
 */
export class ResolvedPath {
  rootId: string = '';
  path: string = '';
  kind: string = '';
  size: number | null = null;
  modifiedAt: number = 0;
  contentType: string | null = null;

  static fromJson(map: JsonMap | null): ResolvedPath {
    const v: ResolvedPath = new ResolvedPath();
    v.rootId = JsonAccess.str(map, 'rootId') ?? '';
    v.path = JsonAccess.str(map, 'path') ?? '';
    v.kind = JsonAccess.str(map, 'kind') ?? '';
    v.size = JsonAccess.num(map, 'size');
    v.modifiedAt = JsonAccess.num(map, 'modifiedAt') ?? 0;
    v.contentType = JsonAccess.str(map, 'contentType');
    return v;
  }
}

export class TrashEntry {
  id: string = '';
  rootId: string = '';
  path: string = '';
  kind: string = '';
  size: number = 0;
  createdAt: number = 0;
  status: string = '';

  static fromJson(map: JsonMap | null): TrashEntry {
    const v: TrashEntry = new TrashEntry();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.rootId = JsonAccess.str(map, 'rootId') ?? '';
    v.path = JsonAccess.str(map, 'path') ?? '';
    v.kind = JsonAccess.str(map, 'kind') ?? '';
    v.size = JsonAccess.num(map, 'size') ?? 0;
    v.createdAt = JsonAccess.num(map, 'createdAt') ?? 0;
    v.status = JsonAccess.str(map, 'status') ?? '';
    return v;
  }
}

/** 文件内容 + 版本标识（`GET roots/{id}/content`，字节流 + ETag / Content-Type 头）。 */
export class FileContent {
  bytes: Uint8Array;
  etag: string;
  contentType: string | null;

  constructor(bytes: Uint8Array = new Uint8Array(0), etag: string = '', contentType: string | null = null) {
    this.bytes = bytes;
    this.etag = etag;
    this.contentType = contentType;
  }
}

