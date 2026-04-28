import { describe, expect, test } from 'bun:test';
import { checkLatestVersion } from './check-latest-version.ts';

describe('checkLatestVersion', () => {
  test('logs warning when installed version differs from latest', async () => {
    const warnCalls: string[] = [];
    const originalWarn = (await import('./logger.ts')).logger.warn;
    const { logger } = await import('./logger.ts');
    logger.warn = (msg: string) => {
      warnCalls.push(msg);
    };

    await checkLatestVersion({ fetchLatest: async () => '99.0.0' });

    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain('Update available');
    expect(warnCalls[0]).toContain('99.0.0');
    expect(warnCalls[0]).toContain('pnpm add -g');

    logger.warn = originalWarn;
  });

  test('does not log when version is up to date', async () => {
    const warnCalls: string[] = [];
    const { logger } = await import('./logger.ts');
    const originalWarn = logger.warn;
    logger.warn = (msg: string) => {
      warnCalls.push(msg);
    };

    const pkg = await import('../../../package.json');
    await checkLatestVersion({ fetchLatest: async () => pkg.default.version });

    expect(warnCalls.length).toBe(0);
    logger.warn = originalWarn;
  });

  test('silently ignores fetch errors', async () => {
    const warnCalls: string[] = [];
    const { logger } = await import('./logger.ts');
    const originalWarn = logger.warn;
    logger.warn = (msg: string) => {
      warnCalls.push(msg);
    };

    await checkLatestVersion({
      fetchLatest: async () => {
        throw new Error('network down');
      },
    });

    expect(warnCalls.length).toBe(0);
    logger.warn = originalWarn;
  });
});
