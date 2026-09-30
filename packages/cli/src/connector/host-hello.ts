// The first message a workstation sends the relay: who it is, what it runs,
// and the facts about its terminal that a browser cannot learn itself.

import os from 'node:os';
import { CAPABILITY, PROTOCOL_VERSION } from 'herdr-remote-relay/protocol';

export interface HostHelloIdentity {
  hostId: string;
  token: string;
  password: string;
  version: string;
  terminalPalette: unknown;
  terminalFont: unknown;
}

export function hostHello(identity: HostHelloIdentity) {
  return {
    type: 'host_hello',
    protocol: PROTOCOL_VERSION,
    hostId: identity.hostId,
    token: identity.token,
    password: identity.password || null,
    hostname: os.hostname(),
    platform: process.platform,
    ...(process.platform === 'win32' &&
    (process.env.MSYSTEM || /(?:^|[\\/])(?:bash|sh)(?:\.exe)?$/i.test(process.env.SHELL || ''))
      ? { shellProfile: 'git-bash' }
      : {}),
    arch: process.arch,
    version: identity.version,
    terminalPalette: identity.terminalPalette || null,
    terminalFont: identity.terminalFont,
    capabilities: [
      CAPABILITY.hostHandoff,
      CAPABILITY.idleHeartbeat,
      CAPABILITY.binaryFrameV2,
      ...(process.platform === 'win32' ? [CAPABILITY.adminTabs] : []),
    ],
  };
}
