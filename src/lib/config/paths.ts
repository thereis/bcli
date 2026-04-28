import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const getConfigDir = () =>
  process.env.BCLI_CONFIG_DIR
    ? resolve(process.env.BCLI_CONFIG_DIR)
    : resolve(homedir(), '.bcli');

export const getConfigFilePath = () => resolve(getConfigDir(), 'config.json');

export const getLocalEnvPath = () => resolve(process.cwd(), '.env');
