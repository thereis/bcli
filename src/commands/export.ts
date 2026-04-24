import { Cli } from 'incur';
import { registerExportCustomersSubcommand } from './handlers/customer/export-customers.ts';

export const registerExportCommand = (cli: Cli.Cli) => {
  const exportCli = Cli.create('export', {
    description: 'Export data to CSV files',
  });

  registerExportCustomersSubcommand(exportCli);

  cli.command(exportCli);
};
