import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';

const ADMIN_BROKER_TASK_NAME = 'HerdrRemoteAdminBroker';
export const ADMIN_BROKER_MAX_MESSAGE_BYTES = 2 * 1_024 * 1_024;

function adminBrokerAccountId(): string {
  const account = `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || process.env.USERPROFILE || 'default'}`;
  return createHash('sha256').update(account.toLowerCase()).digest('hex').slice(0, 24);
}

export function adminBrokerPipePath(): string {
  return `\\\\.\\pipe\\herdr-remote-admin-${adminBrokerAccountId()}`;
}

export function adminBrokerTaskName(): string {
  return `${ADMIN_BROKER_TASK_NAME}-${adminBrokerAccountId()}`;
}

export function sendAdminBrokerMessage(socket: Socket, message: object): void {
  socket.write(`${JSON.stringify(message)}\n`);
}
