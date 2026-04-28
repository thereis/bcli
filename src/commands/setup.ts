import { type Cli, z } from 'incur';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { testStoreConnection } from '../lib/bigcommerce/test-store-connection.ts';
import {
  envExists,
  getEnvPath,
  parseEnvFile,
  saveEnvFile,
} from '../lib/config/env-manager.ts';
import { loadFormFields, saveFormFields } from '../lib/config/form-fields.ts';
import { collectFormFields } from '../lib/config/form-fields-wizard.ts';
import { logger, stdout } from '../lib/shared/logger.ts';

type Step = {
  key: string;
  label: string;
  prompt: string;
  required: boolean;
  defaultValue?: string;
  secret?: boolean;
  validate?: (value: string) => string | null;
};

const STEPS: Step[] = [
  {
    key: 'BC_STORE_HASH',
    label: 'Store Hash',
    prompt:
      'Your BigCommerce store hash (found in your API URL: stores/{hash}/v3)',
    required: true,
    validate: (v) =>
      v.includes('/') ? 'Store hash should not contain slashes' : null,
  },
  {
    key: 'BC_ACCESS_TOKEN',
    label: 'Access Token',
    prompt: 'Your BigCommerce API access token',
    required: true,
    secret: true,
  },
];

const ask = (
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
};

const maskToken = (token: string) => {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
};

export const registerSetupCommand = (cli: Cli.Cli) => {
  cli.command('setup', {
    description: 'Interactive setup — create or update an environment',
    options: z.object({
      env: z
        .string()
        .default('default')
        .describe('Environment name (e.g. development, production)'),
      verbose: z
        .boolean()
        .default(false)
        .describe('Print raw API responses during form-field fetch'),
    }),
    alias: { verbose: 'v' },
    async run({ options }) {
      const envName = options.env;
      const envPath = getEnvPath(envName);

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const envFileValues = parseEnvFile(envPath);
      const dotEnvValues = parseEnvFile(resolve(process.cwd(), '.env'));
      const existing =
        Object.keys(envFileValues).length > 0 ? envFileValues : dotEnvValues;
      const hasExisting = Object.keys(existing).length > 0;

      stdout(`\n  BigCommerce CLI Setup — ${envName}\n`);

      if (hasExisting) {
        logger.info(
          `Found existing "${envName}" environment. Current values will be shown as defaults.`,
        );
        stdout('');
      } else {
        logger.info(`Creating "${envName}" environment.`);
        stdout('');
      }

      const values: Record<string, string> = {};

      for (const step of STEPS) {
        const current = existing[step.key];
        const fallback = current ?? step.defaultValue;

        let displayDefault = fallback;
        if (step.secret && current) {
          displayDefault = maskToken(current);
        }

        const defaultHint = displayDefault ? ` (${displayDefault})` : '';
        const requiredHint = step.required ? ' *' : '';

        let value = '';
        let valid = false;

        while (!valid) {
          stdout(`  ${step.label}${requiredHint}`);
          stdout(`  ${step.prompt}`);
          value = await ask(
            rl,
            `  → ${defaultHint ? `[${displayDefault}] ` : ''}`,
          );

          if (!value && fallback) {
            value = fallback;
          }

          if (step.required && !value) {
            logger.error('This field is required.');
            stdout('');
            continue;
          }

          if (value && step.validate) {
            const error = step.validate(value);
            if (error) {
              logger.error(error);
              stdout('');
              continue;
            }
          }

          valid = true;
        }

        values[step.key] = value;
        stdout('');
      }

      stdout('  Verifying credentials...\n');
      let connected = false;

      while (!connected) {
        const [connError, store] = await testStoreConnection(
          values.BC_STORE_HASH!,
          values.BC_ACCESS_TOKEN!,
        );

        if (connError) {
          logger.error(`✗ ${connError.message}`);
          stdout('');
          const retry = await ask(rl, '  Update credentials and retry? (Y/n) ');

          if (retry.toLowerCase() === 'n') {
            logger.info('Setup cancelled.');
            rl.close();
            process.exit(0);
          }

          for (const step of STEPS.filter(
            (s) => s.key === 'BC_STORE_HASH' || s.key === 'BC_ACCESS_TOKEN',
          )) {
            const current = values[step.key]!;
            const displayDefault = step.secret ? maskToken(current) : current;

            stdout(`  ${step.label} *`);
            stdout(`  ${step.prompt}`);
            const newValue = await ask(rl, `  → [${displayDefault}] `);
            if (newValue) {
              values[step.key] = newValue;
            }
            stdout('');
          }

          continue;
        }

        connected = true;
        logger.info(`✓ Connected to "${store.name}" (${store.domain})`);
        stdout('');
      }

      const existingFormFields = loadFormFields();
      const formFields = await collectFormFields(
        rl,
        existingFormFields,
        values.BC_STORE_HASH!,
        values.BC_ACCESS_TOKEN!,
        options.verbose,
      );

      const envContent = Object.entries(values)
        .filter(([_, val]) => val)
        .map(([key, val]) => `${key}=${val}`)
        .join('\n');

      stdout('  Configuration summary:\n');
      for (const step of STEPS) {
        const val = values[step.key];
        if (!val) continue;
        const display = step.secret ? maskToken(val) : val;
        stdout(`    ${step.label}: ${display}`);
      }
      if (formFields.length > 0) {
        stdout(`    Form fields: ${formFields.map((f) => f.name).join(', ')}`);
      }
      stdout('');

      let targetEnv = envName;
      while (true) {
        const nameAnswer = await ask(rl, `  Environment name [${targetEnv}] `);
        if (nameAnswer) targetEnv = nameAnswer;

        const overriding = envExists(targetEnv);
        const prompt = overriding
          ? `  ⚠  "${targetEnv}" already exists and will be overwritten. Save and activate? (Y/n/r=rename) `
          : `  Save as "${targetEnv}" and activate? (Y/n/r=rename) `;
        const confirm = (await ask(rl, prompt)).toLowerCase();

        if (confirm === 'n') {
          rl.close();
          logger.info('Setup cancelled.');
          process.exit(0);
        }
        if (confirm === 'r') continue;
        break;
      }
      rl.close();

      saveEnvFile(targetEnv, `${envContent}\n`);
      if (formFields !== existingFormFields) {
        saveFormFields(formFields);
      }
      logger.info(`Saved and activated "${targetEnv}" environment.`);
      if (formFields.length > 0) {
        logger.info(
          `Saved ${formFields.length} form field(s) to .bc/form-fields.json.`,
        );
      }
    },
  });
};
