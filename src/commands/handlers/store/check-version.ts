import got from 'got';
import type { Cli } from 'incur';
import pkg from '../../../../package.json' with { type: 'json' };
import type { Cta } from '../../../lib/shared/cta.ts';
import { handlePromise } from '../../../lib/shared/handle-promise.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';
import { logger } from '../../../lib/shared/logger.ts';

export type CheckVersionDeps = {
  fetchLatest: () => Promise<string>;
};

export type CheckVersionResult = {
  data: {
    installed: string;
    latest: string;
    upToDate: boolean;
  };
  cta: Cta;
};

const fetchLatestFromNpm = async (): Promise<string> => {
  const res = await got(`https://registry.npmjs.org/${pkg.name}/latest`).json<{
    version: string;
  }>();

  return res.version;
};

export const checkVersionHandler = async (
  deps: CheckVersionDeps = { fetchLatest: fetchLatestFromNpm },
): Promise<CheckVersionResult> => {
  const installed = pkg.version;

  const [error, latest] = await handlePromise(deps.fetchLatest());

  if (error) {
    exitWithError(`✗ Could not reach npm registry: ${error.message}`);
  }

  const latestVersion = latest as string;
  const upToDate = installed === latestVersion;

  if (upToDate) {
    logger.info(`✓ bcli is up to date (${installed})`);
  } else {
    logger.info(`bcli ${installed} installed — latest is ${latestVersion}`);
    logger.info(`Run: pnpm add -g ${pkg.name}`);
  }

  return {
    data: { installed, latest: latestVersion, upToDate },
    cta: {
      commands: upToDate
        ? []
        : [
            {
              command: `pnpm add -g ${pkg.name}`,
              description: 'Upgrade bcli to the latest version',
            },
          ],
    },
  };
};

export const registerCheckVersionSubcommand = (parent: Cli.Cli) => {
  parent.command('version', {
    description: 'Compare installed bcli version against latest on npm',
    async run(c) {
      const result = await runHandler(() => checkVersionHandler());
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
