import os from 'os';

/** `$USER` is unset under cron, containers and `su`-style shells; the passwd entry is always there. */
export function currentUserName(env: NodeJS.ProcessEnv = process.env): string {
  return env.USER?.trim() || os.userInfo().username;
}
