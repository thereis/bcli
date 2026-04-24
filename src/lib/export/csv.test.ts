import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCsvRow, obscure, readCsvColumnValues } from './csv.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'csv-'));
const paths: string[] = [];

afterEach(() => {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
  paths.length = 0;
});

describe('obscure', () => {
  test('masks the local part and domain while keeping first 2 chars', () => {
    expect(obscure('alice@example.com')).toBe('al***@ex*********');
  });

  test('handles short emails', () => {
    expect(obscure('a@b')).toBe('a@b');
  });

  test('handles empty string', () => {
    expect(obscure('')).toBe('@');
  });
});

describe('appendCsvRow', () => {
  test('writes header then appends row', () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'nested', 'out.csv');
    appendCsvRow(file, { Name: 'Alice', Age: '30' });
    appendCsvRow(file, { Name: 'Bob', Age: '25' });
    const content = readFileSync(file, 'utf-8');
    expect(content).toBe('"Name","Age"\n"Alice","30"\n"Bob","25"\n');
  });

  test('escapes quotes in values', () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'q.csv');
    appendCsvRow(file, { Name: 'She said "hi"' });
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('"She said ""hi"""');
  });
});

describe('readCsvColumnValues', () => {
  test('returns set of values in a column', async () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'read.csv');
    appendCsvRow(file, { ID: '1', Email: 'a@b.c' });
    appendCsvRow(file, { ID: '2', Email: 'd@e.f' });
    appendCsvRow(file, { ID: '1', Email: 'dup@x.y' });
    const ids = await readCsvColumnValues(file, 'ID');
    expect(ids).toEqual(new Set(['1', '2']));
  });

  test('returns empty set when file missing', async () => {
    const ids = await readCsvColumnValues('/no-such/file.csv', 'ID');
    expect(ids.size).toBe(0);
  });

  test('ignores blank values', async () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'blank.csv');
    appendCsvRow(file, { ID: '1', Email: 'a@b.c' });
    appendCsvRow(file, { ID: '', Email: 'd@e.f' });
    const ids = await readCsvColumnValues(file, 'ID');
    expect(ids).toEqual(new Set(['1']));
  });
});
