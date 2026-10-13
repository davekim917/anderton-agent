import { readEnvFile } from './env.js';
import { GITHUB_APP_SENTINEL, resolveGitHubAppToken } from './github-app-token.js';

const HOST_ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TOKEN'];

/**
 * The host's own GitHub identity, not any agent group's: App first, then a PAT, with `.env` merged UNDER
 * `process.env`. `undefined` means the host has none.
 */
export async function resolveHostGitHubToken(): Promise<string | undefined> {
  const env = { ...readEnvFile(HOST_ENV_KEYS), ...process.env };
  // Checked first: resolveGitHubAppToken WARNs on incomplete config every call.
  if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    const minted = await resolveGitHubAppToken(env);
    if (minted) return minted;
  }
  const pat = env.GITHUB_TOKEN;
  return pat && pat !== GITHUB_APP_SENTINEL ? pat : undefined;
}
