import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../relay-config.js';

/** This relay's release, as its package.json names it. */
export const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
).version;
