import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { stateDir } from '../paths.js';

const ADMIN_BROKER_TASK_NAME = 'HerdrRemoteAdminBroker';
const ADMIN_BROKER_HOST = '127.0.0.1';
export const ADMIN_BROKER_MAX_MESSAGE_BYTES = 2 * 1_024 * 1_024;

function adminBrokerAccountId(): string {
  const account = `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || process.env.USERPROFILE || 'default'}`;
  return createHash('sha256').update(account.toLowerCase()).digest('hex').slice(0, 24);
}

export function adminBrokerTaskName(): string {
  return `${ADMIN_BROKER_TASK_NAME}-${adminBrokerAccountId()}`;
}

// Not a named pipe: one created by an elevated process admits only
// Administrators, so the connector's standard token gets EPERM, and opening it
// to everyone would let any account add an instance of the same name and sit
// in the middle. A loopback port cannot be taken over by another account, and
// the token lives in the state directory, which only this account can read.
function endpointPath(): string {
  return path.join(stateDir(), 'admin-broker.json');
}

/** Record where the broker listens, with a fresh token callers must present. */
export function publishAdminBrokerEndpoint(port: number): string {
  const token = randomBytes(32).toString('hex');
  const file = endpointPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ port, token }), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return token;
}

export function adminBrokerTokenMatches(expected: string, received: unknown): boolean {
  if (!expected || typeof received !== 'string') return false;
  const want = Buffer.from(expected);
  const got = Buffer.from(received);
  return want.length === got.length && timingSafeEqual(want, got);
}

function brokerUnavailable(): Error {
  return Object.assign(new Error('The administrator terminal broker is not running.'), {
    code: 'ENOENT',
  });
}

/** Connect to the running broker; the token goes in the first message. */
export function connectAdminBroker(): { socket: net.Socket; token: string } {
  let endpoint: { port?: unknown; token?: unknown };
  try {
    endpoint = JSON.parse(fs.readFileSync(endpointPath(), 'utf8'));
  } catch {
    // Missing or half-written: either way no broker has published itself.
    throw brokerUnavailable();
  }
  const { port, token } = endpoint;
  if (!Number.isInteger(port) || typeof token !== 'string') throw brokerUnavailable();
  return { socket: net.createConnection({ host: ADMIN_BROKER_HOST, port: port as number }), token };
}

export function listenAdminBroker(server: net.Server, onListening: (port: number) => void): void {
  server.listen(0, ADMIN_BROKER_HOST, () => {
    onListening((server.address() as net.AddressInfo).port);
  });
}

export function sendAdminBrokerMessage(socket: net.Socket, message: object): void {
  socket.write(`${JSON.stringify(message)}\n`);
}
