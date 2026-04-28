import { afterEach, describe, expect, test } from 'bun:test';
import type { createInterface } from 'node:readline';
import type { FormField } from './form-fields.ts';
import { collectFormFields } from './form-fields-wizard.ts';

type Readline = ReturnType<typeof createInterface>;

const makeRl = (answers: string[]): Readline => {
  const queue = [...answers];
  return {
    question: (_q: string, cb: (a: string) => void) => {
      const next = queue.shift() ?? '';
      cb(next);
    },
    close: () => {},
  } as unknown as Readline;
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mockFetchFields = (
  data: Array<Record<string, unknown>>,
  raw: unknown = { data },
) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(raw), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
};

describe('collectFormFields', () => {
  test('keeps existing on (k)eep choice', async () => {
    const existing: FormField[] = [{ name: 'A', type: 'string' }];
    const rl = makeRl(['k']);
    const result = await collectFormFields(rl, existing, 'h', 't', false);
    expect(result).toBe(existing);
  });

  test('keeps existing on (s)kip', async () => {
    const existing: FormField[] = [{ name: 'A', type: 'string' }];
    const rl = makeRl(['s']);
    expect(await collectFormFields(rl, existing, 'h', 't', false)).toBe(
      existing,
    );
  });

  test('unknown action falls through to existing', async () => {
    const existing: FormField[] = [{ name: 'A', type: 'string' }];
    const rl = makeRl(['xyz']);
    expect(await collectFormFields(rl, existing, 'h', 't', false)).toBe(
      existing,
    );
  });

  test('default (empty input) with existing keeps', async () => {
    const existing: FormField[] = [{ name: 'A', type: 'string' }];
    const rl = makeRl(['']);
    expect(await collectFormFields(rl, existing, 'h', 't', false)).toBe(
      existing,
    );
  });

  test('fetch path picks all fields by default', async () => {
    mockFetchFields([
      {
        name: 'Phone Verified',
        type: 'radiobuttons',
        extra_info: { options: ['True', 'False'] },
      },
    ]);
    const rl = makeRl(['f', 'all']);
    const result = await collectFormFields(rl, [], 'h', 't', false);
    expect(result).toEqual([
      { name: 'Phone Verified', type: 'string', options: ['True', 'False'] },
    ]);
  });

  test('fetch path with built-ins prompts and can include them', async () => {
    mockFetchFields([
      { name: 'EmailAddress', type: 'text', private_id: 1 },
      { name: 'CustomField', type: 'text' },
    ]);
    const rl = makeRl(['f', 'y', 'all']);
    const result = await collectFormFields(rl, [], 'h', 't', false);
    expect(result).toHaveLength(2);
  });

  test('fetch path with built-ins defaults to hiding them when answered n', async () => {
    mockFetchFields([
      { name: 'EmailAddress', type: 'text', private_id: 1 },
      { name: 'CustomField', type: 'text' },
    ]);
    const rl = makeRl(['f', 'n', '1']);
    const result = await collectFormFields(rl, [], 'h', 't', false);
    expect(result).toEqual([{ name: 'CustomField', type: 'string' }]);
  });

  test('fetch path with no custom fields returns []', async () => {
    mockFetchFields([{ name: 'X', type: 'text', private_id: 1 }]);
    const rl = makeRl(['f', 'n']);
    const result = await collectFormFields(rl, [], 'h', 't', false);
    expect(result).toEqual([]);
  });

  test('fetch error falls back to existing', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const existing: FormField[] = [{ name: 'A', type: 'string' }];
    const rl = makeRl(['f']);
    const result = await collectFormFields(rl, existing, 'h', 't', false);
    expect(result).toBe(existing);
  });

  test('verbose path prints raw response', async () => {
    mockFetchFields([{ name: 'Y', type: 'text' }]);
    const rl = makeRl(['f', 'all']);
    const result = await collectFormFields(rl, [], 'h', 't', true);
    expect(result).toHaveLength(1);
  });

  test('manual path collects entries until blank', async () => {
    const rl = makeRl([
      'm',
      'Trusted',
      'boolean',
      'True,False',
      'Age',
      'number',
      '',
      '',
    ]);
    const result = await collectFormFields(rl, [], 'h', 't', false);
    expect(result).toEqual([
      { name: 'Trusted', type: 'boolean', options: ['True', 'False'] },
      { name: 'Age', type: 'number' },
    ]);
  });

  test('manual path defaults type to string when invalid', async () => {
    const rl = makeRl(['m', 'X', 'weird', '', '']);
    const result = await collectFormFields(rl, [], 'h', 't', false);
    expect(result).toEqual([{ name: 'X', type: 'string' }]);
  });

  test('selection parser supports ranges and csv', async () => {
    mockFetchFields([
      { name: 'A', type: 'text' },
      { name: 'B', type: 'text' },
      { name: 'C', type: 'text' },
      { name: 'D', type: 'text' },
    ]);
    const rl = makeRl(['f', '1,3-4']);
    const result = await collectFormFields(rl, [], 'h', 't', false);
    expect(result.map((f) => f.name)).toEqual(['A', 'C', 'D']);
  });
});
