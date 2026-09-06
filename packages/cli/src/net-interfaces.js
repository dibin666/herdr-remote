'use strict';

const os = require('node:os');

// Interface names that are almost always virtual bridges rather than something
// a phone can reach. They are still listed, just ranked last.
const VIRTUAL_NAME_PATTERN = /^(docker|br-|virbr|veth|vmnet|vboxnet|lxcbr|cni|flannel|kube)/i;
const TAILSCALE_NAME_PATTERN = /^(tailscale|ts)\d*$/i;

/**
 * Is this address inside Tailscale's 100.64.0.0/10 CGNAT range? Interface names
 * differ per platform (tailscale0 on Linux, utunN on macOS), so the address
 * range is the portable signal.
 */
function isTailscaleAddress(address) {
  const octets = String(address).split('.');
  if (octets.length !== 4) return false;
  const first = Number(octets[0]);
  const second = Number(octets[1]);
  if (!Number.isInteger(first) || !Number.isInteger(second)) return false;
  return first === 100 && second >= 64 && second <= 127;
}

function classify(name, info) {
  if (info.internal) return 'loopback';
  if (TAILSCALE_NAME_PATTERN.test(name) || isTailscaleAddress(info.address)) return 'tailscale';
  if (VIRTUAL_NAME_PATTERN.test(name)) return 'virtual';
  return 'lan';
}

const KIND_ORDER = { tailscale: 0, lan: 1, virtual: 2, loopback: 3 };

/**
 * Addresses this machine can be reached at, best candidate first.
 *
 * Tailscale addresses come first because a device on the tailnet reaches them
 * from anywhere, which is exactly the "works away from home without running a
 * relay" case; plain LAN addresses follow, then virtual bridges, then loopback.
 */
function listReachableAddresses({ includeLoopback = true, includeIpv6 = false } = {}) {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const info of entries || []) {
      const family = typeof info.family === 'string' ? info.family : `IPv${info.family}`;
      if (family !== 'IPv4' && !(includeIpv6 && family === 'IPv6')) continue;
      const kind = classify(name, info);
      if (kind === 'loopback' && !includeLoopback) continue;
      results.push({
        name,
        address: info.address,
        family,
        kind,
        internal: Boolean(info.internal),
      });
    }
  }
  results.sort((a, b) => {
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return a.address.localeCompare(b.address);
  });
  return results;
}

/** Best guess for the address to advertise when binding to every interface. */
function preferredLanAddress() {
  const candidates = listReachableAddresses({ includeLoopback: false });
  return candidates.length > 0 ? candidates[0].address : null;
}

module.exports = {
  isTailscaleAddress,
  listReachableAddresses,
  preferredLanAddress,
};
