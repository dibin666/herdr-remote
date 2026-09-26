// Process entry for the host connector; service.ts spawns this file.

import { EXIT_REPLACED } from '../exit-codes.js';
import { HostConnector } from './host-connector.js';

const connector = new HostConnector({ onFatal: (exitCode) => process.exit(exitCode) });
try {
  connector.start();
} catch (error) {
  const { code, message } = error as NodeJS.ErrnoException;
  process.stderr.write(`herdr-remote host connector failed: ${message}\n`);
  process.exitCode = code === 'HOST_ALREADY_RUNNING' ? EXIT_REPLACED : 1;
}
const stop = () => {
  connector.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
