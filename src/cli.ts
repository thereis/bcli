#!/usr/bin/env node
import { Cli } from 'incur';
import pkg from '../package.json' with { type: 'json' };
import { getConfigFilePath } from './lib/config/paths.ts';

const cli = Cli.create('bcli', {
  version: pkg.version,
  description:
    'BigCommerce CLI — search customers, export data, and manage integrations',
  config: {
    flag: 'config',
    files: [getConfigFilePath()],
  },
  mcp: {
    command: 'bcli --mcp',
  },
  format: 'toon',
});

const { registerSetupCommand } = await import('./commands/setup.ts');
const { registerEnvCommand } = await import('./commands/env.ts');

registerSetupCommand(cli);
registerEnvCommand(cli);

const skipEnvCommands = ['setup', 'env'];
const isSkipped = skipEnvCommands.some((cmd) => process.argv.includes(cmd));

if (!isSkipped) {
  const { registerCheckCommand } = await import('./commands/check.ts');
  const { registerCleanCommand } = await import('./commands/clean.ts');
  const { registerExportCommand } = await import('./commands/export.ts');
  const { registerGetCommand } = await import('./commands/get.ts');
  const { registerUpdateCommand } = await import('./commands/update.ts');
  const { logger } = await import('./lib/shared/logger.ts');

  cli.use((_c, next) => {
    const verbose =
      process.argv.includes('-v') || process.argv.includes('--verbose');
    logger.setVerbose(verbose);
    return next();
  });

  const { checkLatestVersion } = await import(
    './lib/shared/check-latest-version.ts'
  );
  checkLatestVersion();

  registerExportCommand(cli);
  registerGetCommand(cli);
  registerUpdateCommand(cli);
  registerCheckCommand(cli);
  registerCleanCommand(cli);
}

cli.serve();
