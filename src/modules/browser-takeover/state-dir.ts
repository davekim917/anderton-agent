import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

const BROWSER_STATE_CONTAINER_PATH = '/workspace/browser-state';

const WORKGROUP_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Saved browser logins (agent-browser state files: cookies and localStorage) for one workgroup. They are live session
 * credentials, so the directory is host-only 0700, outside every git tree and outside the workgroup shared tree that
 * digests and indexers read.
 */
export function browserStateMount(
  workgroupKey: string,
  dataDir: string = DATA_DIR,
): { hostPath: string; containerPath: string; readonly: false } | null {
  if (!WORKGROUP_KEY_RE.test(workgroupKey)) return null;
  const hostPath = path.join(dataDir, 'browser-state', workgroupKey);
  fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(hostPath, 0o700);
  return { hostPath, containerPath: BROWSER_STATE_CONTAINER_PATH, readonly: false };
}
