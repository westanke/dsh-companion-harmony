import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonAccess } from '../../entry/src/main/ets/core/JsonAccess.ts';
import { HistoryEntry } from '../../entry/src/main/ets/core/Models.ts';
import {
  isAbsolutePath, sessionFileRefs,
} from '../../entry/src/main/ets/core/SessionFileRefs.ts';

/**
 * 会话文件引用测试 —— 逐条对应原工程 `SessionFileRefsTest.kt`。
 *
 * 这组断言存在的理由：**误报比没有功能更糟**。它会把用户训练成忽略这个面板，于是真能
 * 打开的那些也被忽略掉。所以「相对路径一律丢弃」「bash 一律不解析」「只有特定工具才
 * 采信兜底的 path 键」这三条边界必须钉死。
 */

/** 造一个会话历史条目：`data` 是事件载荷的 JSON 文本。 */
function entry(seq: number, data: string): HistoryEntry {
  const json = `{"event":{"type":"x","seq":${seq},"time":${seq},"data":${data}}}`;
  return HistoryEntry.fromJson(JsonAccess.asMap(JsonAccess.parse(json)));
}

test('绝对路径判定：/ 开头或 Windows 盘符开头', () => {
  assert.equal(isAbsolutePath('/a/b.txt'), true);
  assert.equal(isAbsolutePath('C:\\Users\\x\\a.txt'), true);
  assert.equal(isAbsolutePath('C:/Users/x/a.txt'), true);
  assert.equal(isAbsolutePath('a.txt'), false);
  assert.equal(isAbsolutePath('./a.txt'), false);
  assert.equal(isAbsolutePath(''), false);
});

test('diffs 采信 meta.diffs 与顶层 diffs 两种形态', () => {
  const nested = sessionFileRefs([entry(1, '{"meta":{"diffs":[{"path":"/a/x.txt"}]}}')]);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].path, '/a/x.txt');

  const legacy = sessionFileRefs([entry(1, '{"diffs":[{"path":"/b/y.txt"}]}')]);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].path, '/b/y.txt');
});

test('同一路径出现多次：计数累加、lastSeq 取最大', () => {
  const refs = sessionFileRefs([
    entry(3, '{"meta":{"diffs":[{"path":"/a/x.txt"}]}}'),
    entry(7, '{"name":"read","arguments":"{\\"file_path\\":\\"/a/x.txt\\"}"}'),
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].count, 2);
  assert.equal(refs[0].lastSeq, 7);
  assert.equal(refs[0].description, null);
});

test('首次出现顺序被保留（首个承载路径的事件先列）', () => {
  const refs = sessionFileRefs([
    entry(1, '{"name":"read","arguments":"{\\"file_path\\":\\"/first.txt\\"}"}'),
    entry(2, '{"name":"read","arguments":"{\\"file_path\\":\\"/second.txt\\"}"}'),
  ]);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].path, '/first.txt');
  assert.equal(refs[1].path, '/second.txt');
});

test('工具参数三处形态都能刮出 file_path', () => {
  const direct = sessionFileRefs([entry(1, '{"name":"read","arguments":"{\\"file_path\\":\\"/a.txt\\"}"}')]);
  assert.equal(direct.length, 1);

  const inContent = sessionFileRefs([
    entry(1, '{"content":[{"name":"write","arguments":"{\\"file_path\\":\\"/b.txt\\"}"}]}'),
  ]);
  assert.equal(inContent.length, 1);
  assert.equal(inContent[0].path, '/b.txt');

  const inMessage = sessionFileRefs([
    entry(1, '{"message":{"name":"edit","arguments":"{\\"file_path\\":\\"/c.txt\\"}"}}'),
  ]);
  assert.equal(inMessage.length, 1);

  const inStream = sessionFileRefs([
    entry(1, '{"stream":[{"chunk":{"block":{"name":"read","arguments":"{\\"file_path\\":\\"/d.txt\\"}"}}}]}'),
  ]);
  assert.equal(inStream.length, 1);
  assert.equal(inStream[0].path, '/d.txt');
});

test('已解析成对象形态的参数也接受', () => {
  const refs = sessionFileRefs([
    entry(1, '{"name":"read","arguments":{"file_path":"/obj.txt"}}'),
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, '/obj.txt');
});

test('未知工具仍然接受 file_path（这个键名本身已足够明确）', () => {
  const refs = sessionFileRefs([
    entry(1, '{"name":"mcp__x__y","arguments":"{\\"file_path\\":\\"/e.txt\\"}"}'),
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, '/e.txt');
});

test('兜底的 path 键只在「语义就是一个文件」的工具上采信', () => {
  const read = sessionFileRefs([entry(1, '{"name":"read","arguments":"{\\"path\\":\\"/r.txt\\"}"}')]);
  assert.equal(read.length, 1);
  // grep / glob 的 path 是搜索目录，不是被改动的文件。
  const grep = sessionFileRefs([entry(1, '{"name":"grep","arguments":"{\\"path\\":\\"/r.txt\\"}"}')]);
  assert.equal(grep.length, 0);
});

test('bash / pwsh / run_code 整体跳过，连 file_path 也不认', () => {
  for (const tool of ['bash', 'pwsh', 'run_code']) {
    const refs = sessionFileRefs([
      entry(1, `{"name":"${tool}","arguments":"{\\"file_path\\":\\"/etc/passwd\\"}"}`),
    ]);
    assert.equal(refs.length, 0, `${tool} 不该被解析`);
  }
});

test('相对路径一律丢弃，绝不猜基准目录', () => {
  const refs = sessionFileRefs([
    entry(1, '{"name":"read","arguments":"{\\"file_path\\":\\"rel.txt\\"}"}'),
  ]);
  assert.equal(refs.length, 0);
});

test('子系统前缀的工具名按最后一段取（read_file 形式）', () => {
  const refs = sessionFileRefs([
    entry(1, '{"name":"fs/read","arguments":"{\\"file_path\\":\\"/f.txt\\"}"}'),
  ]);
  assert.equal(refs.length, 1);
});

test('畸形事件一律跳过，绝不抛异常', () => {
  const refs = sessionFileRefs([
    entry(1, '{"name":"read","arguments":"not json"}'),
    entry(2, '42'),
    entry(3, 'null'),
    entry(4, '{"name":"read","arguments":"{\\"file_path\\":\\"/ok.txt\\"}"}'),
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, '/ok.txt');
});

test('空历史给空列表', () => {
  assert.equal(sessionFileRefs([]).length, 0);
});

test('diffs 里非对象或非字符串 path 的条目被跳过', () => {
  const refs = sessionFileRefs([
    entry(1, '{"meta":{"diffs":[null,"x",{"path":123},{"path":"/keep.txt"}]}}'),
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, '/keep.txt');
});
