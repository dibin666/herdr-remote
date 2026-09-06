'use strict';

const crypto = require('node:crypto');
const { randomToken, readJson, writeJsonAtomic, ensureDir } = require('./state');

function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function equalHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

class AuthStore {
  constructor({ stateFile, pairingTtlMs = 10 * 60 * 1000, deviceTtlMs = 30 * 24 * 60 * 60 * 1000, maxDevices = 32, password = null } = {}) {
    if (!stateFile) throw new TypeError('stateFile is required');
    this.stateFile = stateFile;
    this.pairingTtlMs = pairingTtlMs;
    this.deviceTtlMs = deviceTtlMs;
    this.maxDevices = maxDevices;
    // Optional shared password. When unset the relay is public: anyone may
    // enrol a workstation. That is safe because a workstation is only ever
    // reachable through its own host token, which the relay never hands out.
    this.password = password || null;
    this.pairings = new Map();
    this.lastDeviceSaveAt = new Map();
    this.state = readJson(stateFile, { version: 1, hosts: {}, devices: {} });
    this.state.version = 1;
    this.state.hosts = this.state.hosts && typeof this.state.hosts === 'object' ? this.state.hosts : {};
    this.state.devices = this.state.devices && typeof this.state.devices === 'object' ? this.state.devices : {};
    ensureDir(require('node:path').dirname(stateFile));
  }

  save() {
    writeJsonAtomic(this.stateFile, this.state);
  }

  /** Does this request carry the relay password, if one is required at all? */
  checkPassword(supplied) {
    if (!this.password) return true;
    return typeof supplied === 'string' && equalHash(hash(supplied), hash(this.password));
  }

  /**
   * Enrol a workstation, or re-authenticate one that is already enrolled.
   *
   * The password (when the relay has one) decides who may *join*. The host
   * token decides who may act *as a given workstation*: it is generated on the
   * workstation and only its hash is ever stored here, so even on a public
   * relay nobody else can impersonate an enrolled host or pair a device to it.
   */
  registerHost(hostId, token, password = null, now = Date.now()) {
    if (typeof hostId !== 'string' || hostId.length < 1 || hostId.length > 128 || typeof token !== 'string' || token.length < 16) {
      return { ok: false, code: 'invalid_host_credentials', message: 'hostId and token are required' };
    }
    if (!this.checkPassword(password)) {
      return { ok: false, code: 'relay_password_required', message: 'the relay password is missing or wrong' };
    }
    const existing = this.state.hosts[hostId];
    if (existing) {
      if (!equalHash(existing.tokenHash, hash(token))) {
        return { ok: false, code: 'host_auth_failed', message: 'host token is invalid' };
      }
      existing.lastSeenAt = nowIso(now);
      this.save();
      return { ok: true, hostId, firstSeen: false };
    }

    this.state.hosts[hostId] = {
      tokenHash: hash(token),
      createdAt: nowIso(now),
      lastSeenAt: nowIso(now),
    };
    this.save();
    return { ok: true, hostId, firstSeen: true };
  }

  /** Verify a host token without enrolling anything. */
  authenticateHost(hostId, token) {
    if (typeof hostId !== 'string' || typeof token !== 'string' || token.length < 16) return false;
    const existing = this.state.hosts[hostId];
    return Boolean(existing) && equalHash(existing.tokenHash, hash(token));
  }

  hostCount() {
    return Object.keys(this.state.hosts).length;
  }

  startPairing(hostId, publicUrl, now = Date.now()) {
    if (!this.state.hosts[hostId]) {
      const error = new Error('host is not connected or enrolled');
      error.code = 'host_not_found';
      throw error;
    }
    this.cleanup(now);
    let code;
    do {
      code = randomToken(4).toUpperCase().replace(/[-_]/g, '').slice(0, 6);
    } while ([...this.pairings.values()].some((pairing) => pairing.codeHash === hash(code)));
    const expiresAt = now + this.pairingTtlMs;
    this.pairings.set(code, {
      codeHash: hash(code),
      hostId,
      expiresAt,
      publicUrl,
    });
    return { code, hostId, publicUrl, expiresAt, expiresAtIso: nowIso(expiresAt) };
  }

  completePairing(code, now = Date.now()) {
    if (typeof code !== 'string' || code.length < 4 || code.length > 32) return null;
    this.cleanup(now);
    const normalized = code.trim().toUpperCase();
    const pairing = this.pairings.get(normalized);
    if (!pairing || pairing.expiresAt <= now || pairing.codeHash !== hash(normalized)) return null;
    this.pairings.delete(normalized);

    const devices = Object.values(this.state.devices);
    if (devices.length >= this.maxDevices) {
      devices.sort((a, b) => (a.lastSeenAt || '').localeCompare(b.lastSeenAt || ''));
      delete this.state.devices[devices[0].deviceId];
    }
    const deviceId = `device-${randomToken(9)}`;
    const token = randomToken(32);
    const expiresAt = now + this.deviceTtlMs;
    this.state.devices[deviceId] = {
      deviceId,
      hostId: pairing.hostId,
      tokenHash: hash(token),
      createdAt: nowIso(now),
      lastSeenAt: nowIso(now),
      expiresAt,
    };
    this.save();
    return { deviceId, hostId: pairing.hostId, token, expiresAt, expiresAtIso: nowIso(expiresAt), publicUrl: pairing.publicUrl };
  }

  authenticateDevice(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length < 16) return null;
    const tokenHash = hash(token);
    for (const device of Object.values(this.state.devices)) {
      if (device.expiresAt <= now) continue;
      if (!equalHash(device.tokenHash, tokenHash)) continue;
      device.lastSeenAt = nowIso(now);
      device.expiresAt = now + this.deviceTtlMs;
      const lastSaveAt = this.lastDeviceSaveAt.get(device.deviceId) || 0;
      if (now - lastSaveAt >= 60 * 1000) {
        this.lastDeviceSaveAt.set(device.deviceId, now);
        this.save();
      }
      return { ...device };
    }
    return null;
  }

  cleanup(now = Date.now()) {
    let removedDevices = 0;
    for (const [deviceId, device] of Object.entries(this.state.devices)) {
      if (!device || device.expiresAt <= now) {
        delete this.state.devices[deviceId];
        this.lastDeviceSaveAt.delete(deviceId);
        removedDevices += 1;
      }
    }
    let removedPairings = 0;
    for (const [code, pairing] of this.pairings.entries()) {
      if (pairing.expiresAt <= now) {
        this.pairings.delete(code);
        removedPairings += 1;
      }
    }
    if (removedDevices) this.save();
    return { removedDevices, removedPairings };
  }

  deviceCount() {
    return Object.keys(this.state.devices).length;
  }
}

module.exports = { AuthStore, hash, equalHash, nowIso };
