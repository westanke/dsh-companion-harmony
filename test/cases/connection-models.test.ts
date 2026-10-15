import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Endpoint, EndpointKind, EndpointProbe, EndpointSelection, Host, inferEndpointKind
} from '../../entry/src/main/ets/core/ConnectionModels.ts';

test('inferEndpointKind：局域网/虚拟网/公网/未知', () => {
  assert.equal(inferEndpointKind('http://localhost:3090'), EndpointKind.LAN);
  assert.equal(inferEndpointKind('http://127.0.0.1:3090'), EndpointKind.LAN);
  assert.equal(inferEndpointKind('http://macbook.local:3090'), EndpointKind.LAN);
  assert.equal(inferEndpointKind('http://192.168.1.126:3090'), EndpointKind.LAN);
  assert.equal(inferEndpointKind('http://10.0.0.5:3090'), EndpointKind.LAN);
  assert.equal(inferEndpointKind('http://172.16.0.1:3090'), EndpointKind.LAN);
  assert.equal(inferEndpointKind('http://172.32.0.1:3090'), EndpointKind.WAN);
  assert.equal(inferEndpointKind('http://169.254.1.1:3090'), EndpointKind.LAN);
  assert.equal(inferEndpointKind('http://100.101.102.103:3090'), EndpointKind.VIRTUAL_NET);
  assert.equal(inferEndpointKind('http://8.8.8.8:3090'), EndpointKind.WAN);
  assert.equal(inferEndpointKind('https://example.com'), EndpointKind.UNKNOWN);
});

test('Endpoint.create：归一 baseUrl、推断 kind、label 回退', () => {
  const e = Endpoint.create('家里局域网', 'http://192.168.1.126:3090/api/v1', 'ep1');
  assert.equal(e.baseUrl, 'http://192.168.1.126:3090');
  assert.equal(e.kind, EndpointKind.LAN);
  assert.equal(e.label, '家里局域网');

  const e2 = Endpoint.create('', 'http://8.8.8.8:3090', 'ep2');
  assert.equal(e2.label, 'http://8.8.8.8:3090');
});

test('Host.activeEndpoints：过滤未启用与空地址', () => {
  const h = new Host('h', 'pc', [
    Endpoint.create('a', 'http://192.168.1.1:3090', 'e1'),
    new Endpoint('e2', 'b', 'http://8.8.8.8:3090', EndpointKind.WAN, false),
    new Endpoint('e3', 'c', '', EndpointKind.UNKNOWN, true),
  ]);
  const active = h.activeEndpoints();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'e1');
});

test('EndpointSelection.rank：全失败返回空', () => {
  const r = EndpointSelection.rank([EndpointProbe.failure('e1', 'timeout')], [], null);
  assert.equal(r.length, 0);
});

test('EndpointSelection.rank：延迟升序 + 局域网近似即优先', () => {
  const endpoints = [
    Endpoint.create('lan', 'http://192.168.1.1:3090', 'lan'),
    Endpoint.create('wan', 'http://8.8.8.8:3090', 'wan'),
    Endpoint.create('vpn', 'http://100.64.0.1:3090', 'vpn'),
  ];
  const probes = [
    EndpointProbe.success('wan', 10),
    EndpointProbe.success('vpn', 12),
    EndpointProbe.success('lan', 14), // 14 <= 10 * 1.5 → 并入第 0 档，排最前
  ];
  const r = EndpointSelection.rank(probes, endpoints, null);
  assert.deepEqual(r.map((p) => p.endpointId), ['lan', 'wan', 'vpn']);
});

test('EndpointSelection.rank：局域网超出容差时按延迟排', () => {
  const endpoints = [
    Endpoint.create('lan', 'http://192.168.1.1:3090', 'lan'),
    Endpoint.create('wan', 'http://8.8.8.8:3090', 'wan'),
  ];
  const probes = [EndpointProbe.success('wan', 10), EndpointProbe.success('lan', 16)]; // 16 > 15
  const r = EndpointSelection.rank(probes, endpoints, null);
  assert.deepEqual(r.map((p) => p.endpointId), ['wan', 'lan']);
});

test('EndpointSelection.rank：并列时 preferredEndpointId 优先', () => {
  const endpoints = [
    Endpoint.create('a', 'http://8.8.8.8:3090', 'a'),
    Endpoint.create('b', 'http://9.9.9.9:3090', 'b'),
  ];
  const probes = [EndpointProbe.success('a', 20), EndpointProbe.success('b', 20)];
  const r = EndpointSelection.rank(probes, endpoints, 'b');
  assert.equal(r[0].endpointId, 'b');
});
