import { describe, expect, test } from 'bun:test';
import { createLogger } from './logger.ts';

describe('createLogger', () => {
  test('exposes standard log levels and setVerbose', () => {
    const log = createLogger();
    expect(typeof log.info).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.fatal).toBe('function');
    expect(typeof log.setVerbose).toBe('function');
  });

  test('setVerbose(true) then setVerbose(false) does not throw', () => {
    const log = createLogger();
    log.setVerbose(true);
    log.setVerbose(false);
  });

  test('log methods accept optional data', () => {
    const log = createLogger(true);
    log.info('hello');
    log.info('hello', { a: 1 });
    log.debug('d', { x: 2 });
  });
});
