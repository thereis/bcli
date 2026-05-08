import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { runHandler } from '../../../lib/shared/handler-exit.ts';

export type DeleteWebhookArgs = { id: string };
export type DeleteWebhookDeps = {
  deleteWebhook: (id: number) => Promise<void>;
};
export type DeleteWebhookResult = {
  data: { deleted: boolean; id: number };
  cta: Cta;
};

export const deleteWebhookHandler = async (
  args: DeleteWebhookArgs,
  deps: DeleteWebhookDeps,
): Promise<DeleteWebhookResult> => {
  const id = Number(args.id);
  await deps.deleteWebhook(id);
  return {
    data: { deleted: true, id },
    cta: {
      commands: [
        { command: 'get webhooks', description: 'List remaining webhooks' },
      ],
    },
  };
};

export const registerDeleteWebhookSubcommand = (parent: Cli.Cli) => {
  parent.command('webhook', {
    description: 'Delete a webhook by ID',
    args: z.object({
      id: z.string().describe('Webhook ID'),
    }),
    async run(c) {
      const result = await runHandler(() =>
        deleteWebhookHandler(c.args, {
          deleteWebhook: (id) => createBcClient().deleteWebhook(id),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
