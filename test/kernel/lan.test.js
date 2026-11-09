import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateOrLocalIp } from '../../src/kernel/http.js';
import { getLanAddresses } from '../../src/index.js';

test('isPrivateOrLocalIp detects RFC1918, RFC3927, and IPv6 private addresses accurately', () => {
  // 10.0.0.0/8
  assert.equal(isPrivateOrLocalIp('10.0.0.1'), true);
  assert.equal(isPrivateOrLocalIp('10.10.127.243'), true);
  assert.equal(isPrivateOrLocalIp('10.255.255.255'), true);

  // 192.168.0.0/16
  assert.equal(isPrivateOrLocalIp('192.168.1.1'), true);
  assert.equal(isPrivateOrLocalIp('192.168.199.200'), true);

  // 172.16.0.0/12 (172.16 - 172.31)
  assert.equal(isPrivateOrLocalIp('172.16.0.1'), true);
  assert.equal(isPrivateOrLocalIp('172.24.10.5'), true);
  assert.equal(isPrivateOrLocalIp('172.31.255.254'), true);
  // Non-private 172.x
  assert.equal(isPrivateOrLocalIp('172.15.0.1'), false);
  assert.equal(isPrivateOrLocalIp('172.32.0.1'), false);

  // 169.254.0.0/16 Link-local
  assert.equal(isPrivateOrLocalIp('169.254.1.1'), true);

  // IPv6 ULA / link-local (with/without brackets)
  assert.equal(isPrivateOrLocalIp('fe80::1'), true);
  assert.equal(isPrivateOrLocalIp('[fe80::1]'), true);
  assert.equal(isPrivateOrLocalIp('fc00::1'), true);
  assert.equal(isPrivateOrLocalIp('fd12:3456:789a::1'), true);

  // Non-IP domains and evil hosts must return false
  assert.equal(isPrivateOrLocalIp('evil.com'), false);
  assert.equal(isPrivateOrLocalIp('10.10.127.243.evil.com'), false);
  assert.equal(isPrivateOrLocalIp('192.168.1.1.attacker.org'), false);
  assert.equal(isPrivateOrLocalIp(''), false);
  assert.equal(isPrivateOrLocalIp(null), false);
});

test('getLanAddresses returns local hostname and non-internal IPv4 list', () => {
  const info = getLanAddresses();
  assert.ok(typeof info.hostname === 'string', 'hostname is string');
  assert.ok(Array.isArray(info.lanIps), 'lanIps is array');
  for (const ip of info.lanIps) {
    assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, `valid IPv4: ${ip}`);
    assert.ok(!ip.startsWith('127.'), `non-internal: ${ip}`);
  }
});
