import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodedPathOf, hostNameOf, isUsableBaseUrl, normalizeEndpoint, shareNormalizeBaseUrl, storeNormalizeBaseUrl
} from '../../entry/src/main/ets/core/EndpointUrl.ts';

test('normalizeEndpoint：缺少 /api/v1 时补上', () => {
  assert.equal(normalizeEndpoint('http://192.168.1.126:3090'), 'http://192.168.1.126:3090/api/v1');
});

test('normalizeEndpoint：已带 /api/v1 时不重复追加（含尾斜杠）', () => {
  assert.equal(normalizeEndpoint('http://x:3090/api/v1'), 'http://x:3090/api/v1');
  assert.equal(normalizeEndpoint('http://x:3090/api/v1/'), 'http://x:3090/api/v1');
});

test('normalizeEndpoint：首尾空白被清理', () => {
  assert.equal(normalizeEndpoint('  http://x:3090  '), 'http://x:3090/api/v1');
});

test('normalizeEndpoint：非 http(s) 抛错', () => {
  assert.throws(() => normalizeEndpoint('ftp://x'), /http/);
  assert.throws(() => normalizeEndpoint('192.168.1.1:3090'), /http/);
});

test('encodedPathOf：忽略查询串与锚点', () => {
  assert.equal(encodedPathOf('http://x:3090/api/v1?foo=1'), '/api/v1');
  assert.equal(encodedPathOf('http://x:3090/a/b#c'), '/a/b');
  assert.equal(encodedPathOf('http://x:3090'), '/');
});

test('shareNormalizeBaseUrl：去掉 /api/v1 且协议统一小写', () => {
  assert.equal(shareNormalizeBaseUrl('http://x:3090/api/v1'), 'http://x:3090');
  assert.equal(shareNormalizeBaseUrl('HTTP://X:3090/api/v1'), 'http://X:3090');
  assert.equal(shareNormalizeBaseUrl('https://x:3090/api/v1/'), 'https://x:3090');
});

test('storeNormalizeBaseUrl：缺协议补 http://，并去掉 /api/v1', () => {
  assert.equal(storeNormalizeBaseUrl('192.168.1.126:3090'), 'http://192.168.1.126:3090');
  assert.equal(storeNormalizeBaseUrl('http://x:3090/api/v1'), 'http://x:3090');
  assert.equal(storeNormalizeBaseUrl('   '), '');
});

test('isUsableBaseUrl：必须有主机名且为 http(s)', () => {
  assert.equal(isUsableBaseUrl('http://192.168.1.126:3090'), true);
  assert.equal(isUsableBaseUrl('https://example.com'), true);
  assert.equal(isUsableBaseUrl('ftp://example.com'), false);
  assert.equal(isUsableBaseUrl('http:///path'), false);
});

test('hostNameOf：取主机名，去端口与协议；IPv6 去方括号', () => {
  assert.equal(hostNameOf('http://192.168.1.126:3090'), '192.168.1.126');
  assert.equal(hostNameOf('https://example.com/api/v1'), 'example.com');
  assert.equal(hostNameOf('http://[::1]:3090'), '::1');
});
