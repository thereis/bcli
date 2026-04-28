import pkg from '../../../package.json' with { type: 'json' };
import { handlePromise } from './handle-promise.ts';
import { logger } from './logger.ts';

export type CheckLatestVersionDeps = {
  fetchLatest: () => Promise<string>;
};

const fetchLatestFromNpm = async (): Promise<string> => {
  const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`);
  const json = (await res.json()) as { version: string };
  return json.version;
};

export const checkLatestVersion = async (
  deps: CheckLatestVersionDeps = { fetchLatest: fetchLatestFromNpm },
): Promise<void> => {
  const [error, latest] = await handlePromise(deps.fetchLatest());

  if (error || !latest) return;

  if (pkg.version !== latest) {
    logger.warn(
      `Update available: ${pkg.version} → ${latest} — run \`pnpm add -g ${pkg.name}\` to upgrade`,
    );
  }
};
