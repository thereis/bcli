import { Cli } from 'incur';
import { registerUpdateFormFieldSubcommand } from './handlers/customer/update-form-field.ts';
import { registerUpdateFormFieldsSubcommand } from './handlers/store/update-form-fields.ts';

export const registerUpdateCommand = (cli: Cli.Cli) => {
  const updateCli = Cli.create('update', {
    description: 'Mutate BigCommerce data or local config',
  });

  registerUpdateFormFieldSubcommand(updateCli);
  registerUpdateFormFieldsSubcommand(updateCli);

  cli.command(updateCli);
};
