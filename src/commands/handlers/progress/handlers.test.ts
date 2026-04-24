import { describe, expect, test } from 'bun:test';
import type { ProgressState } from '../../../lib/bigcommerce/schemas.ts';
import type { HandlerExitError } from '../../../lib/shared/handler-exit.ts';
import {
  cleanProgressHandler,
  progressFilePath,
  registerCleanProgressSubcommand,
} from './clean-progress.ts';
import {
  describePhase,
  getProgressHandler,
  registerGetProgressSubcommand,
} from './get-progress.ts';

describe('progressFilePath', () => {
  test('slugifies the key into a .progress-<slug>.json filename', () => {
    expect(progressFilePath('fdd')).toBe('.progress-fdd.json');
    expect(progressFilePath('Phone Verified')).toBe(
      '.progress-phone-verified.json',
    );
    expect(progressFilePath('  weird!!! key  ')).toBe(
      '.progress-weird-key.json',
    );
  });
});

describe('cleanProgressHandler', () => {
  test('invokes clean() with the slugified path and returns metadata', () => {
    const cleaned: string[] = [];
    const result = cleanProgressHandler(
      { key: 'trusted' },
      { clean: (f) => cleaned.push(f) },
    );

    expect(cleaned).toEqual(['.progress-trusted.json']);
    expect(result.data).toEqual({
      cleaned: true,
      key: 'trusted',
      file: '.progress-trusted.json',
    });
    expect(result.cta.commands.length).toBeGreaterThan(0);
  });

  test('slugifies keys before building the filename', () => {
    const cleaned: string[] = [];
    cleanProgressHandler(
      { key: 'Is Trusted Customer' },
      { clean: (f) => cleaned.push(f) },
    );
    expect(cleaned).toEqual(['.progress-is-trusted-customer.json']);
  });
});

describe('describePhase', () => {
  test('phase 1: collecting IDs (no IDs, no cursor)', () => {
    expect(describePhase({ collectedIds: [], processedIdIndex: 0 })).toBe(
      'collecting IDs (phase 1)',
    );
  });
  test('phase 1: still paginating with cursor', () => {
    expect(
      describePhase({
        cursor: 'abc',
        collectedIds: [1, 2],
        processedIdIndex: 0,
      }),
    ).toBe('collecting IDs (phase 1)');
  });
  test('ready for phase 2 when IDs collected and no cursor', () => {
    expect(describePhase({ collectedIds: [1, 2], processedIdIndex: 0 })).toBe(
      'ready for phase 2',
    );
  });
  test('phase 2: fetching customers', () => {
    expect(
      describePhase({ collectedIds: [1, 2, 3], processedIdIndex: 2 }),
    ).toBe('fetching customers (phase 2)');
  });
});

const makeState = (overrides: Partial<ProgressState> = {}): ProgressState => ({
  pageNum: 1,
  collectedIds: [],
  processedIdIndex: 0,
  ...overrides,
});

describe('getProgressHandler', () => {
  test('returns empty when no progress files', () => {
    const result = getProgressHandler(
      {},
      {
        cwd: () => '/tmp',
        listFiles: () => ['other.txt'],
        statMtime: () => new Date(),
        loadState: () => null,
      },
    );
    expect(result.data).toEqual({ progress: [] });
  });

  test('lists multiple progress entries', () => {
    const states: Record<string, ProgressState> = {
      '.progress-foo.json': makeState({ pageNum: 3, collectedIds: [1, 2] }),
      '.progress-bar.json': makeState({ processedIdIndex: 5 }),
    };
    const result = getProgressHandler(
      {},
      {
        cwd: () => '/tmp',
        listFiles: () => [
          '.progress-foo.json',
          '.progress-bar.json',
          'other.txt',
        ],
        statMtime: () => new Date('2026-01-01'),
        loadState: (path) => {
          for (const [file, state] of Object.entries(states)) {
            if (path.endsWith(file)) return state;
          }
          return null;
        },
      },
    );
    const progress = (result.data as { progress: unknown[] }).progress;
    expect(progress).toHaveLength(2);
    expect(result.cta.commands.length).toBeGreaterThan(0);
  });

  test('detail for a specific key', () => {
    const result = getProgressHandler(
      { key: 'foo' },
      {
        cwd: () => '/tmp',
        listFiles: () => ['.progress-foo.json'],
        statMtime: () => new Date('2026-01-01'),
        loadState: () => makeState({ pageNum: 7, collectedIds: [1, 2, 3] }),
      },
    );
    const entry = (result.data as { progress: { key: string } }).progress;
    expect(entry.key).toBe('foo');
  });

  test('throws when key not found', () => {
    let caught: HandlerExitError | null = null;
    try {
      getProgressHandler(
        { key: 'missing' },
        {
          cwd: () => '/tmp',
          listFiles: () => ['.progress-foo.json'],
          statMtime: () => new Date(),
          loadState: () => makeState(),
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('No progress file for "missing"');
  });
});

describe('registrars', () => {
  test('are functions', () => {
    expect(typeof registerCleanProgressSubcommand).toBe('function');
    expect(typeof registerGetProgressSubcommand).toBe('function');
  });
});
