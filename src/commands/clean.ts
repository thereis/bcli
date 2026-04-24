import { Cli } from 'incur';
import { registerCleanProgressSubcommand } from './handlers/progress/clean-progress.ts';

export const registerCleanCommand = (cli: Cli.Cli) => {
  const cleanCli = Cli.create('clean', {
    description: 'Clean up local state',
  });

  registerCleanProgressSubcommand(cleanCli);

  cli.command(cleanCli);
};
