import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { _setClaudeCliForTesting } from '../llm.js';
import { allowSubprocess, allowWritesTo } from '../test-hermeticity.js';

const FAKE_CLI = fileURLToPath(new URL('./fake-claude-cli.mjs', import.meta.url));

export type FakeClaudeReply = {
  result?: string;
  isError?: boolean;
  apiErrorStatus?: number;
  raw?: string;
  exitCode?: number;
  delayMs?: number;
};
export type FakeClaudeCall = { argv: string[]; env: Record<string, string>; stdin: string };

/** Points callHaiku at the fake CLI with a fresh config dir; call `uninstall` in afterEach. */
export function installFakeClaudeCli(): {
  configDir: string;
  script: (replies: Record<string, FakeClaudeReply>) => void;
  calls: () => FakeClaudeCall[];
  uninstall: () => void;
} {
  const configDir = uniqueTmpRoot('fake-claude-cli');
  fs.mkdirSync(configDir, { recursive: true });
  allowWritesTo(configDir);
  allowSubprocess([FAKE_CLI]);
  _setClaudeCliForTesting({ executable: FAKE_CLI, configDir });
  const script = (replies: Record<string, FakeClaudeReply>) =>
    fs.writeFileSync(path.join(configDir, 'replies.json'), JSON.stringify(replies));
  script({});
  return {
    configDir,
    script,
    calls: () => {
      const file = path.join(configDir, 'calls.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as FakeClaudeCall);
    },
    uninstall: () => {
      _setClaudeCliForTesting(null);
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}
