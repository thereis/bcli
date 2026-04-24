import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Cli, z } from 'incur';
import type { ProgressState } from '../../../lib/bigcommerce/schemas.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';
import { logger } from '../../../lib/shared/logger.ts';
import { loadProgress } from '../../../lib/shared/progress.ts';

const PROGRESS_PREFIX = '.progress-';
const PROGRESS_SUFFIX = '.json';

const fileToKey = (file: string) =>
  file.slice(PROGRESS_PREFIX.length, -PROGRESS_SUFFIX.length);

export const describePhase = (state: {
  cursor?: string;
  collectedIds: number[];
  processedIdIndex: number;
}) => {
  if (state.processedIdIndex > 0) return 'fetching customers (phase 2)';
  if (state.collectedIds.length > 0 && !state.cursor)
    return 'ready for phase 2';
  return 'collecting IDs (phase 1)';
};

export type ProgressEntry = {
  key: string;
  file: string;
  path: string;
  state: ProgressState;
  mtime: Date;
};

export type GetProgressArgs = { key?: string };
export type GetProgressDeps = {
  cwd: () => string;
  listFiles: (dir: string) => string[];
  statMtime: (path: string) => Date;
  loadState: (path: string) => ProgressState | null;
};

export type GetProgressResult = {
  data: { progress: ProgressEntry[] } | { progress: ProgressEntry };
  cta: Cta;
};

const ctaForEntry = (entry: ProgressEntry): Cta['commands'] => [
  {
    command: `clean progress ${entry.key}`,
    description: 'Remove this progress file',
  },
  {
    command: `export customers ${entry.key} --resume`,
    description: 'Resume this export (re-supply original flags)',
  },
];

export const getProgressHandler = (
  args: GetProgressArgs,
  deps: GetProgressDeps,
): GetProgressResult => {
  const cwd = deps.cwd();
  const files = deps
    .listFiles(cwd)
    .filter(
      (f) => f.startsWith(PROGRESS_PREFIX) && f.endsWith(PROGRESS_SUFFIX),
    );

  if (files.length === 0) {
    logger.info('No in-flight exports found.');
    return { data: { progress: [] }, cta: { commands: [] } };
  }

  const entries: ProgressEntry[] = files
    .map((file) => {
      const path = resolve(cwd, file);
      const state = deps.loadState(path);
      if (!state) return null;
      const mtime = deps.statMtime(path);
      return { key: fileToKey(file), file, path, state, mtime };
    })
    .filter((e): e is ProgressEntry => e !== null);

  if (args.key) {
    const found = entries.find((e) => e.key === args.key);
    if (!found) {
      exitWithError(
        `No progress file for "${args.key}". Known: ${entries.map((e) => e.key).join(', ')}`,
      );
    }
    const match = found as ProgressEntry;
    return {
      data: { progress: match },
      cta: { commands: ctaForEntry(match) },
    };
  }

  const commands = entries.flatMap(ctaForEntry).slice(0, 4);
  return { data: { progress: entries }, cta: { commands } };
};

export const registerGetProgressSubcommand = (parent: Cli.Cli) => {
  parent.command('progress', {
    description: 'List in-flight export progress files',
    args: z.object({
      key: z
        .string()
        .optional()
        .describe('Show full details for a single export key'),
    }),
    async run(c) {
      const result = await runHandler(() =>
        getProgressHandler(c.args, {
          cwd: () => process.cwd(),
          listFiles: (dir) => readdirSync(dir),
          statMtime: (path) => statSync(path).mtime,
          loadState: (path) => loadProgress(path),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
