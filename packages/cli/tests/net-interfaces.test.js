import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isTailscaleAddress,
  listReachableAddresses,
  preferredLanAddress,
} from '../src/net-interfaces.js';

function interfaceInfo(address) {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

test('the Tailscale CGNAT range is recognised by address', () => {
  // Interface names differ per platform (tailscale0 on Linux, utunN on macOS),
  // so 100.64.0.0/10 is the portable signal.
  assert.equal(isTailscaleAddress('100.64.0.1'), true);
  assert.equal(isTailscaleAddress('100.100.100.100'), true);
  assert.equal(isTailscaleAddress('100.127.255.254'), true);

  assert.equal(isTailscaleAddress('100.63.255.255'), false);
  assert.equal(isTailscaleAddress('100.128.0.1'), false);
  assert.equal(isTailscaleAddress('192.168.1.5'), false);
  assert.equal(isTailscaleAddress('10.0.0.1'), false);
  assert.equal(isTailscaleAddress('::1'), false);
  assert.equal(isTailscaleAddress('not an address'), false);
});

test('reachable addresses are classified and ranked', () => {
  const addresses = listReachableAddresses();
  assert.ok(Array.isArray(addresses));

  for (const entry of addresses) {
    assert.ok(['tailscale', 'lan', 'virtual', 'loopback'].includes(entry.kind));
    assert.equal(entry.family, 'IPv4');
  }

  // Loopback is a last resort: it can never serve a phone.
  const kinds = addresses.map((entry) => entry.kind);
  const firstLoopback = kinds.indexOf('loopback');
  if (firstLoopback !== -1) {
    assert.equal(
      kinds.slice(firstLoopback).every((kind) => kind === 'loopback'),
      true,
    );
  }

  // Tailscale outranks plain LAN, which is what makes it a usable default.
  const firstLan = kinds.indexOf('lan');
  const lastTailscale = kinds.lastIndexOf('tailscale');
  if (firstLan !== -1 && lastTailscale !== -1) assert.ok(lastTailscale < firstLan);
});

test('excluding loopback leaves only addresses another device could reach', () => {
  const addresses = listReachableAddresses({ includeLoopback: false });
  assert.equal(
    addresses.some((entry) => entry.internal),
    false,
  );

  const preferred = preferredLanAddress();
  if (addresses.length === 0) assert.equal(preferred, null);
  else assert.equal(preferred, addresses[0].address);
});

test('Windows virtual and link-local interfaces rank below Wi-Fi', () => {
  const interfaces = {
    'vEthernet (WSL)': [interfaceInfo('172.24.80.1')],
    'vEthernet (Default Switch)': [interfaceInfo('172.20.224.1')],
    'VMware Network Adapter VMnet8': [interfaceInfo('192.168.88.1')],
    'VirtualBox Host-Only Network': [interfaceInfo('192.168.56.1')],
    Ethernet: [interfaceInfo('169.254.12.34')],
    'Wi-Fi': [interfaceInfo('192.168.1.42')],
  };
  const addresses = listReachableAddresses({ interfaces });
  const byName = Object.fromEntries(addresses.map((entry) => [entry.name, entry]));

  assert.equal(byName['vEthernet (WSL)'].kind, 'virtual');
  assert.equal(byName['vEthernet (Default Switch)'].kind, 'virtual');
  assert.equal(byName['VMware Network Adapter VMnet8'].kind, 'virtual');
  assert.equal(byName['VirtualBox Host-Only Network'].kind, 'virtual');
  assert.equal(byName.Ethernet.kind, 'virtual');
  assert.equal(byName['Wi-Fi'].kind, 'lan');
  assert.equal(preferredLanAddress(interfaces), '192.168.1.42');
});
