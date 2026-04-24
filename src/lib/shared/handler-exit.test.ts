import { describe, expect, mock, spyOn, test } from 'bun:test';
import {
  exitWithError,
  exitWithInfo,
  HandlerExitError,
  runHandler,
} from './handler-exit.ts';
import { logger } from './logger.ts';

describe('HandlerExitError', () => {
  test('defaults to code 1, kind error', () => {
    const err = new HandlerExitError('oops');
    expect(err.code).toBe(1);
    expect(err.kind).toBe('error');
    expect(err.name).toBe('HandlerExitError');
  });

  test('respects overrides', () => {
    const err = new HandlerExitError('done', { code: 0, kind: 'info' });
    expect(err.code).toBe(0);
    expect(err.kind).toBe('info');
  });
});

describe('exit helpers', () => {
  test('exitWithError throws error-kind HandlerExitError', () => {
    expect(() => exitWithError('bad', 2)).toThrow(HandlerExitError);
    try {
      exitWithError('bad', 2);
    } catch (e) {
      const err = e as HandlerExitError;
      expect(err.kind).toBe('error');
      expect(err.code).toBe(2);
    }
  });

  test('exitWithInfo throws info-kind HandlerExitError', () => {
    try {
      exitWithInfo('bye', 0);
    } catch (e) {
      const err = e as HandlerExitError;
      expect(err.kind).toBe('info');
      expect(err.code).toBe(0);
    }
  });
});

describe('runHandler', () => {
  test('returns value on success', async () => {
    const result = await runHandler(() => 'ok');
    expect(result).toBe('ok');
  });

  test('awaits async functions', async () => {
    const result = await runHandler(async () => 42);
    expect(result).toBe(42);
  });

  test('rethrows non-HandlerExitError', async () => {
    await expect(
      runHandler(() => {
        throw new Error('real bug');
      }),
    ).rejects.toThrow('real bug');
  });

  test('calls process.exit with code on HandlerExitError (error)', async () => {
    const exitCalls: number[] = [];
    const exitSpy = spyOn(process, 'exit').mockImplementation(((
      code?: number,
    ) => {
      exitCalls.push(code ?? 0);
      throw new Error('__exit__');
    }) as never);
    const errorSpy = spyOn(logger, 'error').mockImplementation(mock(() => {}));

    await expect(runHandler(() => exitWithError('bad', 3))).rejects.toThrow(
      '__exit__',
    );

    expect(exitCalls).toEqual([3]);
    expect(errorSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('calls process.exit with code on HandlerExitError (info)', async () => {
    const exitCalls: number[] = [];
    const exitSpy = spyOn(process, 'exit').mockImplementation(((
      code?: number,
    ) => {
      exitCalls.push(code ?? 0);
      throw new Error('__exit__');
    }) as never);
    const infoSpy = spyOn(logger, 'info').mockImplementation(mock(() => {}));

    await expect(runHandler(() => exitWithInfo('done', 0))).rejects.toThrow(
      '__exit__',
    );

    expect(exitCalls).toEqual([0]);
    expect(infoSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
    infoSpy.mockRestore();
  });

  test('skips log when message empty', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((
      _code?: number,
    ) => {
      throw new Error('__exit__');
    }) as never);
    await expect(
      runHandler(() => {
        throw new HandlerExitError('');
      }),
    ).rejects.toThrow('__exit__');
    exitSpy.mockRestore();
  });
});
