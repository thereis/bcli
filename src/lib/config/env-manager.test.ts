import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateEnv,
  envExists,
  getActiveEnv,
  getEnvPath,
  listEnvs,
  loadActiveEnv,
  parseEnvFile,
  removeEnv,
  saveEnvFile,
  setActiveEnv,
} from './env-manager.ts';

const originalCwd = process.cwd();
const originalConfigDir = process.env.BCLI_CONFIG_DIR;
let workDir = '';
let configDir = '';

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'env-mgr-'));
  configDir = mkdtempSync(join(tmpdir(), 'env-mgr-config-'));
  process.env.BCLI_CONFIG_DIR = configDir;
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfigDir === undefined) {
    delete process.env.BCLI_CONFIG_DIR;
  } else {
    process.env.BCLI_CONFIG_DIR = originalConfigDir;
  }
  rmSync(workDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe('env-manager', () => {
  test('getActiveEnv returns null when no active file', () => {
    expect(getActiveEnv()).toBeNull();
  });

  test('setActiveEnv and getActiveEnv roundtrip', () => {
    setActiveEnv('prod');
    expect(getActiveEnv()).toBe('prod');
  });

  test('getEnvPath returns config path for named env', () => {
    expect(getEnvPath('staging')).toBe(join(configDir, 'staging.env'));
  });

  test('listEnvs returns [] when config dir missing', () => {
    expect(listEnvs()).toEqual([]);
  });

  test('listEnvs marks active env', () => {
    saveEnvFile('dev', 'FOO=bar\n');
    saveEnvFile('prod', 'FOO=baz\n');
    setActiveEnv('prod');
    const envs = listEnvs();
    expect(envs.find((e) => e.name === 'prod')?.active).toBe(true);
    expect(envs.find((e) => e.name === 'dev')?.active).toBe(false);
  });

  test('envExists reflects the config file', () => {
    expect(envExists('missing')).toBe(false);
    saveEnvFile('present', 'X=1\n');
    expect(envExists('present')).toBe(true);
  });

  test('saveEnvFile writes the named env globally and sets active', () => {
    saveEnvFile('dev', 'FOO=bar\n');
    expect(existsSync(join(process.cwd(), '.env'))).toBe(false);
    expect(readFileSync(getEnvPath('dev'), 'utf-8')).toBe('FOO=bar\n');
    expect(getActiveEnv()).toBe('dev');
  });

  test('activateEnv sets active without writing repo .env', () => {
    saveEnvFile('dev', 'A=1\n');
    saveEnvFile('prod', 'A=2\n');
    activateEnv('dev');
    expect(existsSync(join(process.cwd(), '.env'))).toBe(false);
    expect(getActiveEnv()).toBe('dev');
  });

  test('activateEnv throws for missing env', () => {
    expect(() => activateEnv('ghost')).toThrow(/does not exist/);
  });

  test('removeEnv deletes file and clears active when removing active', () => {
    saveEnvFile('dev', 'A=1\n');
    setActiveEnv('dev');
    removeEnv('dev');
    expect(existsSync(getEnvPath('dev'))).toBe(false);
    expect(getActiveEnv()).toBeNull();
  });

  test('removeEnv preserves active when removing a different env', () => {
    saveEnvFile('dev', 'A=1\n');
    saveEnvFile('prod', 'A=2\n');
    setActiveEnv('prod');
    removeEnv('dev');
    expect(getActiveEnv()).toBe('prod');
  });

  test('removeEnv throws for missing env', () => {
    expect(() => removeEnv('ghost')).toThrow(/does not exist/);
  });

  test('parseEnvFile returns {} when file missing', () => {
    expect(parseEnvFile('/missing/.env')).toEqual({});
  });

  test('parseEnvFile parses KEY=VALUE, strips quotes, ignores comments', () => {
    const p = join(workDir, 'sample.env');
    writeFileSync(p, '# comment\nFOO=bar\nBAR="baz qux"\nBAZ=\'single\'\n');
    expect(parseEnvFile(p)).toEqual({
      FOO: 'bar',
      BAR: 'baz qux',
      BAZ: 'single',
    });
  });

  test('loadActiveEnv loads from named env when set', () => {
    saveEnvFile('dev', 'BC_TEST_LOAD_1=alpha\n');
    setActiveEnv('dev');
    loadActiveEnv();
    expect(process.env.BC_TEST_LOAD_1).toBe('alpha');
    delete process.env.BC_TEST_LOAD_1;
  });

  test('loadActiveEnv loads from .env when no active', () => {
    writeFileSync(join(process.cwd(), '.env'), 'BC_TEST_LOAD_2=beta\n');
    loadActiveEnv();
    expect(process.env.BC_TEST_LOAD_2).toBe('beta');
    delete process.env.BC_TEST_LOAD_2;
  });
});
