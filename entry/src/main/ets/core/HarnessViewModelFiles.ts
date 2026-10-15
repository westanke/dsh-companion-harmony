/**
 * 界面主状态机 —— **第 3 层：文件浏览与编辑**（从 `HarnessViewModel.ts` 拆出）。
 *
 * 从根目录列表一路到编辑/保存：目录分页（`loadDirectory` / `loadNextDirectoryPage`）、
 * `@` 候选（`loadMentionEntries`）、打开与动作选择（`openEntry` / `selectEntryForAction` /
 * `updateDocument` / `saveDocument`）、新建/移动/回收（`createEntry` / `moveSelected` /
 * `trashSelected` / `loadTrash` / `restoreTrash`）、以及上传/替换/下载。
 *
 * 会话层（第 4 层）的 `openSessionFile` 与事件层（第 6 层）的 `handleEvent` 都要调它的
 * `loadDirectory` / `loadMentionEntries`，所以它必须排在它们前面。
 *
 * 拆分来龙去脉见 `HarnessViewModel.ts`。
 */

import {
  ChatSession,
  DirectoryPage,
  FileContent,
  FileEntry,
  TrashEntry,
} from './Models';
import {
  DshClient,
} from './DshClient';
import {
  PreviewKind,
  binaryPreviewByteLimit,
  previewKind,
  previewKindOf,
} from './PreviewKind';
import {
  UTF8_BOM,
  utf8Encode,
} from './Codec';
import {
  isBlank,
  trimChar,
} from './TextPredicates';
import {
  HarnessState,
  OpenDocument,
  MAX_EDIT_BYTES,
  FILE_TOO_LARGE,
  BINARY_FILE,
} from './HarnessTypes';
import {
  DecodedText,
  decodeUtf8,
  concatBytes,
  childPath,
} from './HarnessHelpers';
import { HarnessViewModelCatalog } from './HarnessViewModelCatalog';

export class HarnessViewModelFiles extends HarnessViewModelCatalog {
  // ————————————————— 文件浏览与编辑 —————————————————

  async selectRoot(id: string): Promise<void> {
    this.update((s: HarnessState): void => {
      s.selectedRootId = id;
      s.currentPath = '';
      s.document = null;
    });
    await this.loadDirectory('');
  }

  async loadDirectory(path: string | null = null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const target: string = path !== null ? path : this.state.currentPath;
      const normalized: string = trimChar(target, '/');
      const page: DirectoryPage = await api.entries(root, normalized);
      this.update((s: HarnessState): void => {
        s.currentPath = normalized;
        s.directory = page;
        s.document = null;
      });
    });
  }

  async loadNextDirectoryPage(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const current: DirectoryPage | null = this.state.directory;
      if (current === null) {
        return;
      }
      const cursor: string | null = current.nextCursor;
      if (cursor === null) {
        return;
      }
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const next: DirectoryPage = await api.entries(root, current.path, cursor);
      this.update((s: HarnessState): void => {
        const seen: Set<string> = new Set<string>();
        const merged: FileEntry[] = [];
        const all: FileEntry[] = current.entries.concat(next.entries);
        for (let i = 0; i < all.length; i++) {
          const e: FileEntry = all[i];
          if (!seen.has(e.path)) {
            seen.add(e.path);
            merged.push(e);
          }
        }
        s.directory = current.withMerged(merged, next.nextCursor);
      });
    });
  }

  /**
   * 加载当前会话**工作目录**的条目，供输入框 `@` 补全。
   *
   * **只用两步，不走 `resolvePath`**：会话里已经有 `rootId`，而 `cwd` 本身就是「相对授权根」
   * 的 wire 路径 —— 列举接口要的正是这两样。
   *
   * **`cwd` 为空字符串是合法值**，表示会话工作目录就是授权根本身。此前把它当成「没有工作
   * 目录」丢掉 —— 线上那句「读不到这个会话的工作目录」就是这么来的。
   *
   * 拿不到时把 `mentionFailed` 置真，让界面如实说「读不到」，而不是谎称「目录是空的」。
   */
  async loadMentionEntries(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const sessionId: string | null = this.state.selectedSessionId;
      if (sessionId === null) {
        return;
      }
      let session: ChatSession | null = null;
      for (let i = 0; i < this.state.sessions.length; i++) {
        if (this.state.sessions[i].id === sessionId) {
          session = this.state.sessions[i];
          break;
        }
      }
      if (session === null) {
        return;
      }
      let page: DirectoryPage | null = null;
      try {
        // 空 cwd（= 授权根本身）照常列举；trim('/') 只把结尾多余的斜杠收干净。
        page = await api.entries(session.rootId, trimChar(session.cwd, '/'));
      } catch (e) {
        page = null;
      }
      // 会话可能在请求期间被切走，回来发现已是另一个会话就别把那批文件塞进去。
      if (this.state.selectedSessionId !== sessionId) {
        return;
      }
      const got: DirectoryPage | null = page;
      this.update((s: HarnessState): void => {
        if (got === null) {
          s.mentionEntries = null;
          s.mentionFailed = true;
        } else {
          s.mentionEntries = got.entries;
          s.mentionFailed = false;
        }
      });
    });
  }

  /**
   * 把「输入框上方的补全面板开着」这个事实同步出去，供外层抽屉决定是否响应滑动手势。
   *
   * 只在**值真的变了**的时候写 state —— 这个函数会在重组路径上被调到，每次无条件 update
   * 会白白推一串快照。
   */
  setComposerOverlay(active: boolean): void {
    if (this.state.composerOverlay === active) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.composerOverlay = active;
    });
  }

  async openEntry(entry: FileEntry): Promise<void> {
    if (entry.kind === 'directory') {
      await this.loadDirectory(entry.path);
      return;
    }
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      // 图片与 PDF 有自己的字节上限：文本的 2 MiB 闸对它们太紧，但也不能不设闸。
      const provisional: PreviewKind = previewKind(entry.name, null);
      const capRaw: number | null = binaryPreviewByteLimit(provisional);
      const cap: number = capRaw !== null ? capRaw : MAX_EDIT_BYTES;
      if (entry.size > cap) {
        this.update((s: HarnessState): void => {
          s.document = new OpenDocument(entry, null, '', false, '\n', null, null, true);
          // 文本超限沿用既有的全局提示；图片 / PDF 的提示由预览面板自己给（带「下载」出路）。
          s.error = provisional === PreviewKind.IMAGE || provisional === PreviewKind.PDF
            ? null : FILE_TOO_LARGE;
        });
        return;
      }
      const content: FileContent = await api.readFile(root, entry.path);
      // 拿到字节后重判一次：FileEntry 里没有 contentType，服务端 MIME 也不可靠，
      // 所以「没有扩展名 / 扩展名是 .bin 的图片」只能靠魔数认出来。
      const kind: PreviewKind = previewKindOf(entry.name, content.contentType, content.bytes);
      if (kind === PreviewKind.IMAGE || kind === PreviewKind.PDF) {
        this.update((s: HarnessState): void => {
          s.document = new OpenDocument(entry, null, content.etag, false, '\n',
            content.contentType, content.bytes, false);
          s.error = null;
        });
        return;
      }
      const decoded: DecodedText | null = decodeUtf8(content.bytes);
      this.update((s: HarnessState): void => {
        s.document = new OpenDocument(entry, decoded !== null ? decoded.text : null, content.etag,
          decoded !== null ? decoded.hasBom : false, decoded !== null ? decoded.lineEnding : '\n',
          content.contentType, null, false);
        s.error = decoded === null ? BINARY_FILE : null;
      });
    });
  }

  selectEntryForAction(entry: FileEntry): void {
    this.update((s: HarnessState): void => {
      s.document = new OpenDocument(entry);
    });
  }

  updateDocument(text: string): void {
    this.update((s: HarnessState): void => {
      s.document = s.document === null ? null : s.document.withText(text);
    });
  }

  async saveDocument(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const document: OpenDocument | null = this.state.document;
      if (document === null) {
        return;
      }
      const text: string | null = document.text;
      if (text === null) {
        return;
      }
      const normalized: string = text.split('\r\n').join('\n').split('\r').join('\n');
      let encoded: string = normalized;
      if (document.lineEnding === '\r\n') {
        encoded = normalized.split('\n').join('\r\n');
      } else if (document.lineEnding === '\r') {
        encoded = normalized.split('\n').join('\r');
      }
      const body: Uint8Array = utf8Encode(encoded);
      const bytes: Uint8Array = document.hasBom ? concatBytes(UTF8_BOM, body) : body;
      const etag: string = await api.writeFile(root, document.entry.path, bytes, document.etag);
      this.update((s: HarnessState): void => {
        s.document = s.document === null ? null : s.document.withEtag(etag);
      });
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      this.update((s: HarnessState): void => {
        s.directory = page;
      });
    });
  }

  async createEntry(name: string, directory: boolean): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      await api.createEntry(root, childPath(this.state.currentPath, name), directory);
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      this.update((s: HarnessState): void => {
        s.directory = page;
      });
    });
  }

  async moveSelected(destination: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const document: OpenDocument | null = this.state.document;
      if (document === null) {
        return;
      }
      await api.moveEntry(root, document.entry.path, trimChar(destination, '/'));
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      this.update((s: HarnessState): void => {
        s.document = null;
        s.directory = page;
      });
    });
  }

  async trashSelected(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const document: OpenDocument | null = this.state.document;
      if (document === null) {
        return;
      }
      await api.trashEntry(root, document.entry.path);
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      const trash: TrashEntry[] = await api.trash();
      this.update((s: HarnessState): void => {
        s.document = null;
        s.directory = page;
        s.trash = trash;
      });
    });
  }

  /** 上传一个新文件到当前目录（平台层已读好字节）。 */
  async upload(name: string, bytes: Uint8Array): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      await api.writeFile(root, childPath(this.state.currentPath, name), bytes, null);
      const page: DirectoryPage = await api.entries(root, this.state.currentPath);
      this.update((s: HarnessState): void => {
        s.directory = page;
      });
    });
  }

  /** 用一段新字节替换当前选中的文件（etag 为空时先读一次拿权威值）。 */
  async replaceSelected(bytes: Uint8Array): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const root: string | null = this.state.selectedRootId;
      if (root === null) {
        return;
      }
      const document: OpenDocument | null = this.state.document;
      if (document === null) {
        return;
      }
      let etag: string = document.etag;
      if (isBlank(etag)) {
        const content: FileContent = await api.readFile(root, document.entry.path);
        etag = content.etag;
      }
      await api.writeFile(root, document.entry.path, bytes, etag);
      await this.openEntry(document.entry.withSize(bytes.length));
    });
  }

  /** 下载当前选中的文件：平台层用返回的字节写盘。 */
  async downloadSelected(): Promise<Uint8Array> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return new Uint8Array(0);
    }
    const root: string | null = this.state.selectedRootId;
    if (root === null) {
      return new Uint8Array(0);
    }
    const document: OpenDocument | null = this.state.document;
    if (document === null) {
      return new Uint8Array(0);
    }
    const content: FileContent = await api.readFile(root, document.entry.path);
    return content.bytes;
  }

  async loadTrash(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const trash: TrashEntry[] = await api.trash();
      this.update((s: HarnessState): void => {
        s.trash = trash;
      });
    });
  }

  async restoreTrash(id: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.restoreTrash(id);
      const trash: TrashEntry[] = await api.trash();
      this.update((s: HarnessState): void => {
        s.trash = trash;
      });
      await this.loadDirectory(null);
    });
  }
}
