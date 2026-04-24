import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { logger } from '../../../lib/shared/logger.ts';
import { removeProgress } from '../../../lib/shared/progress.ts';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export type CleanProgressDeps = {
  clean: (path: string) => void;
};

export type CleanProgressArgs = { key: string };
export type CleanProgressData = {
  cleaned: true;
  key: string;
  file: string;
};
export type CleanProgressResult = {
  data: CleanProgressData;
  cta: Cta;
};

export const progressFilePath = (key: string) =>
  `.progress-${slugify(key)}.json`;

export const cleanProgressHandler = (
  args: CleanProgressArgs,
  deps: CleanProgressDeps = { clean: removeProgress },
): CleanProgressResult => {
  const file = progressFilePath(args.key);
  deps.clean(file);
  logger.info(`Cleaned progress for "${args.key}" (${file})`);
  return {
    data: { cleaned: true, key: args.key, file },
    cta: {
      commands: [
        {
          command: 'get progress',
          description: 'List remaining in-flight exports',
        },
      ],
    },
  };
};

export const registerCleanProgressSubcommand = (parent: Cli.Cli) => {
  parent.command('progress', {
    description: 'Remove progress file for an export key',
    args: z.object({
      key: z.string().describe('Export key used when running export customers'),
    }),
    run(c) {
      const result = cleanProgressHandler(c.args, {
        clean: (file) => createBcClient().cleanProgress(file),
      });
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
