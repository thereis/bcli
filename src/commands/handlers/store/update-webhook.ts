import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Webhook } from '../../../lib/bigcommerce/schemas.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { handlePromise } from '../../../lib/shared/handle-promise.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';

export type UpdateWebhookArgs = { id: string };
export type UpdateWebhookOptions = { is_active: string };
export type UpdateWebhookDeps = {
  updateWebhook: (
    id: number,
    patch: Partial<Pick<Webhook, 'is_active'>>,
  ) => Promise<Webhook>;
};
export type UpdateWebhookResult = { data: Webhook; cta: Cta };

export const updateWebhookHandler = async (
  args: UpdateWebhookArgs,
  options: UpdateWebhookOptions,
  deps: UpdateWebhookDeps,
): Promise<UpdateWebhookResult> => {
  const id = Number(args.id);
  if (!Number.isFinite(id) || id <= 0) {
    exitWithError(`Invalid webhook ID: ${args.id}`);
  }

  const active = options.is_active.toLowerCase();
  if (active !== 'true' && active !== 'false') {
    exitWithError(`--is_active must be "true" or "false"`);
  }

  const [error, webhook] = await handlePromise(
    deps.updateWebhook(id, { is_active: active === 'true' }),
  );
  if (error) {
    exitWithError(`Error: ${error.message}`);
  }

  return {
    data: webhook as Webhook,
    cta: {
      commands: [{ command: 'get webhooks', description: 'List all webhooks' }],
    },
  };
};

export const registerUpdateWebhookSubcommand = (parent: Cli.Cli) => {
  parent.command('webhook', {
    description: 'Update a webhook by ID',
    args: z.object({
      id: z.string().describe('Webhook ID'),
    }),
    options: z.object({
      is_active: z
        .string()
        .describe('Set webhook active state: "true" or "false"'),
    }),
    async run(c) {
      const result = await runHandler(() =>
        updateWebhookHandler(c.args, c.options, {
          updateWebhook: (id, patch) =>
            createBcClient().updateWebhook(id, patch),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
