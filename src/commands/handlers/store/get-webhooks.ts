import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Webhook } from '../../../lib/bigcommerce/schemas.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { runHandler } from '../../../lib/shared/handler-exit.ts';

export type GetWebhooksArgs = Record<string, never>;
export type GetWebhooksDeps = { getWebhooks: () => Promise<Webhook[]> };
export type GetWebhooksResult = { data: Webhook[]; cta: Cta };

export const getWebhooksHandler = async (
  _args: GetWebhooksArgs,
  deps: GetWebhooksDeps,
): Promise<GetWebhooksResult> => {
  const webhooks = await deps.getWebhooks();
  return { data: webhooks, cta: { commands: [] } };
};

export const registerGetWebhooksSubcommand = (parent: Cli.Cli) => {
  parent.command('webhooks', {
    description: 'List all webhooks configured for the store',
    args: z.object({}),
    async run(c) {
      const result = await runHandler(() =>
        getWebhooksHandler(c.args, {
          getWebhooks: () => createBcClient().getWebhooks(),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
