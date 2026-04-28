import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { getConfigDir, getLocalEnvPath } from './paths.ts';

const activeFile = () => resolve(getConfigDir(), 'active');

const ensureConfigDir = () => {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

export const getEnvPath = (name: string) =>
  resolve(getConfigDir(), `${name}.env`);

export const getActiveEnv = (): string | null => {
  const f = activeFile();
  if (!existsSync(f)) return null;
  return readFileSync(f, 'utf-8').trim();
};

export const setActiveEnv = (name: string) => {
  ensureConfigDir();
  writeFileSync(activeFile(), name);
};

export const listEnvs = (): { name: string; active: boolean }[] => {
  const active = getActiveEnv();
  const dir = getConfigDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.env'))
    .map((f) => f.replace('.env', ''));

  return files.map((name) => ({
    name,
    active: name === active,
  }));
};

export const envExists = (name: string) => existsSync(getEnvPath(name));

export const activateEnv = (name: string) => {
  const source = getEnvPath(name);
  if (!existsSync(source)) {
    throw new Error(
      `Environment "${name}" does not exist. Run "bcli setup --env ${name}" to create it.`,
    );
  }
  setActiveEnv(name);
};

export const saveEnvFile = (name: string, content: string) => {
  ensureConfigDir();
  writeFileSync(getEnvPath(name), content);
  setActiveEnv(name);
};

export const removeEnv = (name: string) => {
  const p = getEnvPath(name);
  if (!existsSync(p)) {
    throw new Error(`Environment "${name}" does not exist.`);
  }
  const active = getActiveEnv();
  unlinkSync(p);
  const f = activeFile();
  if (active === name && existsSync(f)) {
    unlinkSync(f);
  }
};

export const parseEnvFile = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf-8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const [, rawKey, rawVal] = match;
      if (!rawKey || rawVal === undefined) continue;
      const key = rawKey.trim();
      const val = rawVal.trim().replace(/^["']|["']$/g, '');
      result[key] = val;
    }
  }
  return result;
};

const applyEnvValues = (values: Record<string, string>) => {
  for (const [key, val] of Object.entries(values)) {
    process.env[key] = val;
  }
};

export const loadActiveEnv = () => {
  applyEnvValues(parseEnvFile(getLocalEnvPath()));

  const name = getActiveEnv();
  if (name) {
    applyEnvValues(parseEnvFile(getEnvPath(name)));
  }
};
