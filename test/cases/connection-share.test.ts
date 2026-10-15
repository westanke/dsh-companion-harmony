import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectionShare, SHARE_PREFIX, ShareEndpoint, SharePayload,
} from '../../entry/src/main/ets/core/ConnectionShare.ts';
import { CredentialKind, EndpointKind } from '../../entry/src/main/ets/core/ConnectionModels.ts';

function samplePayload(): SharePayload {
  return new SharePayload(
    '家里的电脑',
    [
      new ShareEndpoint('家里局域网', 'http://192.168.1.126:3090/api/v1'),
      new ShareEndpoint('公司虚拟网', 'http://100.101.102.103:3090'),
    ],
    'token-abcdefghijklmnopqrstuvwxyz0123456789AB',
    'Pixel 9',
    ['files.read'],
  );
}

test('ConnectionShare：encode/decode 往返，地址归一且字段保留', () => {
  const text = ConnectionShare.encode(samplePayload());
  assert.ok(text.startsWith(SHARE_PREFIX));

  const back = ConnectionShare.decode(text) as SharePayload;
  assert.ok(back !== null);
  assert.equal(back.displayName, '家里的电脑');
  assert.equal(back.endpoints.length, 2);
  assert.equal(back.endpoints[0].baseUrl, 'http://192.168.1.126:3090', '/api/v1 必须被去掉');
  assert.equal(back.endpoints[0].label, '家里局域网');
  assert.equal(back.endpoints[1].baseUrl, 'http://100.101.102.103:3090');
  assert.equal(back.token, 'token-abcdefghijklmnopqrstuvwxyz0123456789AB');
  assert.equal(back.deviceName, 'Pixel 9');
  assert.deepEqual(back.scopes, ['files.read']);
});

test('ConnectionShare：不写本机状态字段，长度预算 ≤ 600', () => {
  const text = ConnectionShare.encode(samplePayload());
  assert.ok(text.length <= 600, `实际长度 ${text.length}`);

  const back = ConnectionShare.decode(text) as SharePayload;
  assert.equal(back.endpoints[0].id, '', 'encode 不得写出 Endpoint.id');
});

test('ConnectionShare：协议名统一小写、尾斜杠被去掉', () => {
  const text = ConnectionShare.encode(new SharePayload(
    'pc', [new ShareEndpoint('', 'HTTP://192.168.1.126:3090/')], null, null, [],
  ));
  const back = ConnectionShare.decode(text) as SharePayload;
  assert.equal(back.endpoints[0].baseUrl, 'http://192.168.1.126:3090');
  assert.equal(back.endpoints[0].label, '', 'label 为空则不写该键');
  assert.equal(back.token, null);
});

test('ConnectionShare：encode 对非法输入抛错（唯一故意抛异常处）', () => {
  assert.throws(() => ConnectionShare.encode(new SharePayload('x', [], null, null, [])));
  assert.throws(() => ConnectionShare.encode(new SharePayload('x', [new ShareEndpoint('a', 'ftp://1.2.3.4')], null, null, [])));
  assert.throws(() => ConnectionShare.encode(new SharePayload('x', [new ShareEndpoint('a', 'http:///nohost')], null, null, [])));
});

test('ConnectionShare：decode 容错——带标签、内部换行、前缀大小写', () => {
  const text = ConnectionShare.encode(samplePayload());
  const body = text.substring(SHARE_PREFIX.length);

  const withLabel = ConnectionShare.decode(`Pixel 9 Pro 的配置：\n${text}。`) as SharePayload;
  assert.ok(withLabel !== null);

  const lowercasePrefix = ConnectionShare.decode(`dsh1:${body}`) as SharePayload;
  assert.ok(lowercasePrefix !== null);
  assert.equal(lowercasePrefix.displayName, '家里的电脑');

  // 前缀被换行拆开（clean 会先删掉所有空白）
  const splitPrefix = ConnectionShare.decode(`DS\nH1:\n${body}`) as SharePayload;
  assert.ok(splitPrefix !== null);
  assert.equal(splitPrefix.endpoints.length, 2);
});

test('ConnectionShare：decode 容错——标准字母表与结尾标点', () => {
  const text = ConnectionShare.encode(samplePayload());
  const body = text.substring(SHARE_PREFIX.length);
  const standard = body.replace(/-/g, '+').replace(/_/g, '/');

  const fromStandard = ConnectionShare.decode(`${SHARE_PREFIX}${standard}`) as SharePayload;
  assert.ok(fromStandard !== null, '邮件/网页转码成标准字母表后也应能解');
  assert.equal(fromStandard.displayName, '家里的电脑');

  const withPunctuation = ConnectionShare.decode(`${SHARE_PREFIX}${body}」。`) as SharePayload;
  assert.ok(withPunctuation !== null, '结尾粘上标点不应导致失败');
});

test('ConnectionShare：decode 对任何非法输入返回 null，绝不抛异常', () => {
  assert.equal(ConnectionShare.decode(''), null);
  assert.equal(ConnectionShare.decode('这只是一段普通聊天文本'), null);
  assert.equal(ConnectionShare.decode(`${SHARE_PREFIX}!!!`), null);
  assert.equal(ConnectionShare.decode(`${SHARE_PREFIX}QUJD`), null, '合法 base64 但内容不是配置 JSON');
  assert.equal(ConnectionShare.decode(`${SHARE_PREFIX}`), null);
});

test('ConnectionShare：decode 拒绝没有可用地址的配置', () => {
  const empty = `${SHARE_PREFIX}${Buffer.from(JSON.stringify({ displayName: 'x', endpoints: [{}] }), 'utf8')
    .toString('base64url')}`;
  assert.equal(ConnectionShare.decode(empty), null);
});

test('ConnectionShare：buildHost 的 id 派生、kind 推断与默认值', () => {
  const payload = ConnectionShare.decode(ConnectionShare.encode(samplePayload())) as SharePayload;
  const host = ConnectionShare.buildHost(payload, () => 'HOST-ID', () => 12_345);

  assert.equal(host.id, 'HOST-ID');
  assert.equal(host.displayName, '家里的电脑');
  assert.equal(host.preferredEndpointId, null, '刚导入时不存在「上次成功地址」');
  assert.equal(host.createdAt, 12_345);
  assert.equal(host.updatedAt, 12_345);
  assert.deepEqual(host.endpoints.map((e) => e.id), ['HOST-ID-ep1', 'HOST-ID-ep2']);
  assert.equal(host.endpoints[0].kind, EndpointKind.LAN);
  assert.equal(host.endpoints[1].kind, EndpointKind.VIRTUAL_NET);
  assert.equal(host.endpoints[0].lastLatencyMs, null, '新导入地址不得带探活历史');
  assert.equal(host.credential?.kind, CredentialKind.DEVICE_TOKEN);
  assert.equal(host.credential?.deviceName, 'Pixel 9');
  assert.deepEqual(host.credential?.scopes, ['files.read']);
  assert.equal(host.credential?.issuedAt, 12_345);
});

test('ConnectionShare：buildHost 沿用 payload 自带地址 id，displayName 空则回退「电脑」', () => {
  const payload = new SharePayload('   ', [
    new ShareEndpoint('', 'http://192.168.1.5:3090', '  custom-id  '),
    new ShareEndpoint('  带空格的标签  ', 'http://8.8.8.8:3090'),
  ], '   ', null, []);

  const host = ConnectionShare.buildHost(payload, () => 'H', () => 1);
  assert.equal(host.displayName, '电脑');
  assert.equal(host.credential, null, 'token 为空白时不应建凭据');
  assert.equal(host.endpoints[0].id, 'custom-id');
  assert.equal(host.endpoints[0].label, 'http://192.168.1.5:3090', 'label 空则回退为地址');
  assert.equal(host.endpoints[1].id, 'H-ep2');
  assert.equal(host.endpoints[1].label, '带空格的标签');
});
