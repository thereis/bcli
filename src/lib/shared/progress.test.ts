import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgressState } from '../bigcommerce/schemas.ts';
import { loadProgress, removeProgress, saveProgress } from './progress.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'progress-'));
const paths: string[] = [];

afterEach(() => {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
  paths.length = 0;
});

const state: ProgressState = {
  pageNum: 3,
  collectedIds: [1, 2, 3],
  processedIdIndex: 2,
  cursor: 'abc',
};

describe('progress persistence', () => {
  test('save then load roundtrip', () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'p.json');
    saveProgress(file, state);
    expect(loadProgress(file)).toEqual(state);
  });

  test('load returns null when file missing', () => {
    expect(loadProgress('/nonexistent-/x.json')).toBeNull();
  });

  test('remove deletes the file', () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'p.json');
    saveProgress(file, state);
    removeProgress(file);
    expect(existsSync(file)).toBe(false);
  });

  test('remove is a no-op when file missing', () => {
    expect(() => removeProgress('/nonexistent-/x.json')).not.toThrow();
  });
});
