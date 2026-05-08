import { Cli } from 'incur';
import { registerDeleteWebhookSubcommand } from './handlers/store/delete-webhook.ts';

export const registerDeleteCommand = (cli: Cli.Cli) => {
  const deleteCli = Cli.create('delete', {
    description: 'Delete BigCommerce resources',
  });

  registerDeleteWebhookSubcommand(deleteCli);

  cli.command(deleteCli);
};
