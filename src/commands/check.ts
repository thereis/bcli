import { Cli } from 'incur';
import { registerCheckConnectionSubcommand } from './handlers/store/check-connection.ts';
import { registerCheckVersionSubcommand } from './handlers/store/check-version.ts';

export const registerCheckCommand = (cli: Cli.Cli) => {
  const checkCli = Cli.create('check', {
    description: 'Diagnostics and health checks',
  });

  registerCheckConnectionSubcommand(checkCli);
  registerCheckVersionSubcommand(checkCli);

  cli.command(checkCli);
};
