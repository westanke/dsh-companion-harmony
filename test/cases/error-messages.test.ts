import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NetworkFailureKind, allEndpointsUnreachableText, localizedErrorText, networkErrorText,
  normalizeErrorCode,
} from '../../entry/src/main/ets/core/ErrorMessages.ts';

/**
 * 出错文案本地化表的测试（原工程没有对应的单测文件 —— 那张表过去只靠肉眼看）。
 *
 * 三件事必须钉住：
 * 1. 归一化：带前缀的码（`DSH_SESSION/MODEL_UNAVAILABLE`）只认最后一段；
 * 2. **认不出就返回 null**（调用方保留服务端原文），这条是不变的设计原则；
 * 3. 中英两列的完整性 —— 英文列若漏一条会「静默回退中文」，所以逐码断言两列不相等。
 */

// ── 归一化 ──

test('归一化：原样的大写码不变', () => {
  assert.equal(normalizeErrorCode('PATH_NOT_FOUND'), 'PATH_NOT_FOUND');
});

test('归一化：小写与首尾空白都会被处理', () => {
  assert.equal(normalizeErrorCode('  path_not_found  '), 'PATH_NOT_FOUND');
  assert.equal(normalizeErrorCode('\tModel_Unavailable\n'), 'MODEL_UNAVAILABLE');
});

test('归一化：带前缀的码只认最后一段', () => {
  // 内核有时给 `DSH_SESSION/MODEL_UNAVAILABLE` 这类前缀码。
  assert.equal(normalizeErrorCode('DSH_SESSION/MODEL_UNAVAILABLE'), 'MODEL_UNAVAILABLE');
  assert.equal(normalizeErrorCode('a/b/c/PATH_NOT_FILE'), 'PATH_NOT_FILE');
});

test('归一化：null / 空串 / 纯空白都是 null', () => {
  assert.equal(normalizeErrorCode(null), null);
  assert.equal(normalizeErrorCode(''), null);
  assert.equal(normalizeErrorCode('   '), null);
  assert.equal(normalizeErrorCode('\u3000'), null);
});

test('归一化：分隔符在末尾时结果是空串（照抄原工程 substringAfterLast 的行为）', () => {
  assert.equal(normalizeErrorCode('A/B/'), '');
});

test('归一化：空白的口径与 Kotlin 一致（U+FEFF 不算空白）', () => {
  // Kotlin 的 trim() 不去 U+FEFF，所以 `\uFEFF` 会被当成有效码的一部分。
  assert.equal(normalizeErrorCode('\uFEFF'), '\uFEFF');
});

// ── 按码取文案 ──

test('已知码 → 中文句子', () => {
  assert.equal(localizedErrorText('PATH_NOT_FOUND', 'zh-CN'), '找不到这个路径，可能已经被删了');
  assert.equal(localizedErrorText('PATH_OUTSIDE_ROOTS', 'zh-CN'), '这个路径不在任何已授权的目录里');
  assert.equal(localizedErrorText('TOKEN_INVALID', 'zh-CN'), '登录状态已失效，请重新配对这台设备');
});

test('已知码 → 英文句子', () => {
  assert.equal(localizedErrorText('PATH_NOT_FOUND', 'en-US'),
    'That path no longer exists — it may have been deleted');
  assert.equal(localizedErrorText('PATH_NOT_FOUND', 'en-GB'),
    'That path no longer exists — it may have been deleted');
});

test('语言解析：只有 en 开头走英文，其余全落中文', () => {
  const zh = '找不到这个路径，可能已经被删了';
  for (const lang of ['zh', 'zh-CN', 'zh-TW', 'ja', 'de', 'fr-FR', '', 'zh-Hans']) {
    assert.equal(localizedErrorText('PATH_NOT_FOUND', lang), zh, `语言 ${lang} 应落中文`);
  }
  const en = 'That path no longer exists — it may have been deleted';
  for (const lang of ['en', 'en-US', 'en_US', 'EN-gb', 'EN']) {
    assert.equal(localizedErrorText('PATH_NOT_FOUND', lang), en, `语言 ${lang} 应落英文`);
  }
});

test('归一化后的前缀码也能取到文案', () => {
  assert.equal(localizedErrorText('DSH_SESSION/MODEL_UNAVAILABLE', 'zh-CN'),
    '这个模型现在用不了（可能不支持当前的推理强度，或者没配置好）');
  assert.equal(localizedErrorText('dsh_session/message_empty', 'zh-CN'), '还没输入内容');
});

test('认不出的码返回 null（不硬猜）', () => {
  assert.equal(localizedErrorText('NO_SUCH_CODE', 'zh-CN'), null);
  assert.equal(localizedErrorText('Dsh/Whatever', 'en-US'), null);
});

test('null / 空码返回 null', () => {
  assert.equal(localizedErrorText(null, 'zh-CN'), null);
  assert.equal(localizedErrorText('', 'zh-CN'), null);
  assert.equal(localizedErrorText('   ', 'zh-CN'), null);
});

test('同一意思的多个码共用一条文案（用户看的是该怎么办，不是码编号）', () => {
  const same = localizedErrorText('PATH_NOT_DIRECTORY', 'zh-CN');
  assert.equal(localizedErrorText('PATH_NOT_FILE', 'zh-CN'), same);
  assert.equal(localizedErrorText('WORKSPACE_PATH_NOT_DIRECTORY', 'zh-CN'), same);

  const changed = localizedErrorText('ETAG_MISMATCH', 'zh-CN');
  for (const code of ['ETAG_REQUIRED', 'COPY_VERIFY_FAILED', 'TRASH_VERIFY_FAILED', 'RESTORE_CONFLICT']) {
    assert.equal(localizedErrorText(code, 'zh-CN'), changed, `${code} 应与 ETAG_MISMATCH 共用文案`);
  }
});

test('兜底那条会把原始错误码填进正文（便于贴给开发者）', () => {
  assert.equal(localizedErrorText('ROUTE_NOT_FOUND', 'zh-CN'), '操作没能完成（ROUTE_NOT_FOUND）');
  assert.equal(localizedErrorText('ROUTE_NOT_FOUND', 'en-US'), 'That action didn\'t complete (ROUTE_NOT_FOUND)');
  // 填进去的是**原始**码，不是归一化后的，这样界面上看到的和用户能贴出来的一字不差。
  assert.equal(localizedErrorText('DSH_SERVER/internal_error', 'zh-CN'),
    '操作没能完成（DSH_SERVER/internal_error）');
});

// ── 网络层分类 ──

test('网络失败四类各有自己的句子', () => {
  assert.equal(networkErrorText(NetworkFailureKind.TIMEOUT, 'zh-CN'), '连接超时了，请检查网络后重试');
  assert.equal(networkErrorText(NetworkFailureKind.UNREACHABLE, 'zh-CN'), '找不到服务器，请检查地址是否正确、网络是否连通');
  assert.equal(networkErrorText(NetworkFailureKind.REFUSED, 'zh-CN'), '连接被拒绝了，请确认远程访问已开启');
  assert.equal(networkErrorText(NetworkFailureKind.RESET, 'zh-CN'), '网络连接中断了，请重试');
});

test('网络失败四类的英文列同样完整', () => {
  assert.equal(networkErrorText(NetworkFailureKind.TIMEOUT, 'en-US'),
    'Connection timed out — check your network and try again');
  assert.equal(networkErrorText(NetworkFailureKind.REFUSED, 'en-US'),
    'Connection refused — make sure remote access is enabled');
});

test('其余网络故障附上原始详情，便于排查', () => {
  assert.equal(networkErrorText(NetworkFailureKind.OTHER, 'zh-CN', 'ECONNRESET'),
    '网络请求失败了（ECONNRESET）');
  assert.equal(networkErrorText(NetworkFailureKind.OTHER, 'en-US', 'boom'),
    'Network request failed (boom)');
  // 详情为 null 时不至于拼出半句残句。
  assert.equal(networkErrorText(NetworkFailureKind.OTHER, 'zh-CN'), '网络请求失败了（）');
});

test('「所有地址都没通」有专用文案（不是按错误码查表）', () => {
  assert.equal(allEndpointsUnreachableText('zh-CN'),
    '连不上这台电脑，所有地址都没通（检查电脑是否开机、远程访问是否开启）');
  assert.equal(allEndpointsUnreachableText('en'),
    'Can\'t reach this computer — no endpoint responded (is it on? is remote access enabled?)');
});

test('网络层文案永不返回空串（分类已完成，不留给用户空白提示）', () => {
  for (const kind of [NetworkFailureKind.TIMEOUT, NetworkFailureKind.UNREACHABLE,
    NetworkFailureKind.REFUSED, NetworkFailureKind.RESET, NetworkFailureKind.OTHER]) {
    for (const lang of ['zh-CN', 'en-US', 'ja']) {
      assert.ok(networkErrorText(kind, lang, 'x').length > 0);
    }
  }
  assert.ok(allEndpointsUnreachableText('de').length > 0);
});

// ── 映射表完整性 ──

/**
 * 映射表里全部 79 个码。硬编码在这里是**故意**的：它同时充当「映射表没被误删」的回归锁。
 * 断言三件事：清单无重复、每个码中英两列都有正文、且两条**不相同**（若英文列漏了一条会
 * 静默回退中文，这条断言正是为了抓住那种沉默的漏译）。
 */
const ALL_CODES: string[] = [
  'AUTH_REQUIRED', 'TOKEN_INVALID', 'PAIRING_INVALID', 'DEVICE_NOT_FOUND',
  'ROOT_FORBIDDEN', 'ROOT_INVALID', 'ROOT_NOT_FOUND',
  'SCOPE_REQUIRED', 'SCOPE_INVALID', 'FORBIDDEN', 'ADMIN_LOOPBACK_REQUIRED', 'SETTINGS_READ_ONLY',
  'PATH_OUTSIDE_ROOT', 'PATH_OUTSIDE_ROOTS', 'PATH_NOT_FOUND', 'TRASH_NOT_FOUND',
  'PATH_NOT_DIRECTORY', 'PATH_NOT_FILE', 'WORKSPACE_PATH_NOT_DIRECTORY', 'PATH_ALREADY_EXISTS',
  'PATH_INVALID', 'PATH_NOT_ABSOLUTE', 'PATH_REQUIRED', 'MOVE_INVALID', 'CREATE_CONDITION_REQUIRED',
  'FILE_TYPE_UNSUPPORTED', 'LINK_TRAVERSAL_FORBIDDEN',
  'ETAG_MISMATCH', 'ETAG_REQUIRED', 'COPY_VERIFY_FAILED', 'TRASH_VERIFY_FAILED', 'RESTORE_CONFLICT',
  'SESSION_NOT_FOUND', 'WORKSPACE_NOT_FOUND', 'SESSION_FORK_OUTSIDE_ROOT', 'WORKSPACE_OUTSIDE_ROOT',
  'SESSION_TITLE_INVALID', 'WORKSPACE_TITLE_INVALID', 'MESSAGE_EMPTY',
  'COMMAND_NOT_FOUND', 'COMMAND_INVALID', 'COMMAND_FAILED', 'COMMANDS_UNAVAILABLE',
  'APPROVAL_NOT_PENDING',
  'QUESTION_NOT_PENDING', 'QUESTION_NOT_ANSWERABLE', 'QUESTION_ANSWER_INVALID',
  'QUESTION_REPLY_QUEUED', 'USER_QUESTIONS_UNAVAILABLE',
  'RATE_LIMITED', 'CURSOR_INVALID', 'RANGE_INVALID', 'NUMBER_INVALID',
  'MODEL_UNAVAILABLE', 'MODEL_DOES_NOT_SUPPORT_IMAGES', 'MODEL_SELECTION_INVALID', 'MODEL_CONFIG_INVALID',
  'PROVIDER_BASE_URL_REQUIRED', 'PROVIDER_ID_INVALID', 'PROVIDER_MODELS_REQUIRED',
  'PROVIDER_NOT_CONFIGURABLE', 'PROVIDER_NOT_FOUND', 'PROVIDER_PROTOCOL_INVALID', 'PROVIDER_REQUIRED',
  'PROVIDER_EXISTS', 'CUSTOM_PROVIDERS_UNAVAILABLE', 'AGENT_PRESET_INVALID',
  'LISTENER_HOST_INVALID', 'LISTENER_PORT_INVALID', 'LISTENER_CHANGE_PENDING', 'REMOTE_ENABLED',
  'ACCOUNT_SIGNED_OUT',
  'BODY_INVALID', 'JSON_INVALID', 'BODY_TOO_LARGE', 'METHOD_NOT_ALLOWED', 'ROUTE_NOT_FOUND',
  'INTERNAL_ERROR', 'HTTP_ERROR',
];

test('清单覆盖映射表里全部 79 个码，且无重复', () => {
  assert.equal(ALL_CODES.length, 79);
  assert.equal(new Set(ALL_CODES).size, ALL_CODES.length);
});

test('清单里每个码都能取到中英两条不同的正文', () => {
  for (const code of ALL_CODES) {
    const zh = localizedErrorText(code, 'zh-CN');
    const en = localizedErrorText(code, 'en-US');
    assert.notEqual(zh, null, `${code} 缺中文正文`);
    assert.notEqual(en, null, `${code} 缺英文正文`);
    assert.notEqual(zh, en, `${code} 的英文正文与中文相同（英文列可能漏了一条，静默回退中文）`);
  }
});

test('清单之外的码一个都不认（不硬猜）', () => {
  for (const code of ['', 'NOPE', 'DSH_X/UNKNOWN_CODE', 'PATH', 'ERROR']) {
    assert.equal(localizedErrorText(code, 'zh-CN'), null, `${code} 不该被认出来`);
  }
});
