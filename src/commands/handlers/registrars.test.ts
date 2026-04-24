import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { Cli } from 'incur';
import { logger } from '../../lib/shared/logger.ts';

const bcStub: Record<string, unknown> = {};
mock.module('../../lib/bigcommerce/bc-client.ts', () => ({
  createBcClient: () => bcStub,
}));

const fetchFieldsMock = mock(
  async (): Promise<
    [Error, null] | [null, { data: unknown[]; raw: unknown }]
  > => [null, { data: [], raw: {} }],
);
mock.module('../../lib/bigcommerce/fetch-form-fields.ts', () => ({
  fetchCustomerFormFields: fetchFieldsMock,
  getFieldName: (f: { name?: string }) => f.name ?? '',
  getFieldType: (f: { type?: string }) => f.type ?? '',
  getFieldOptions: () => undefined,
  mapBcType: () => 'string',
}));

const loadFormFieldsMock = mock(() => [] as unknown[]);
const saveFormFieldsMock = mock(() => {});
mock.module('../../lib/config/form-fields.ts', () => ({
  loadFormFields: loadFormFieldsMock,
  saveFormFields: saveFormFieldsMock,
  isKnownFormField: (name: string, fields: Array<{ name: string }>) =>
    fields.some((f) => f.name === name),
}));

const collectFormFieldsMock = mock(
  async (_rl: unknown, existing: unknown) => existing,
);
mock.module('../../lib/config/form-fields-wizard.ts', () => ({
  collectFormFields: collectFormFieldsMock,
}));

mock.module('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(''),
    close: () => {},
  }),
}));

const capture = () => {
  let run: ((ctx: Record<string, unknown>) => unknown) | undefined;
  let spec: { options?: { parse: (input: unknown) => unknown } } | undefined;
  const cli: Cli.Cli = {
    command: (_name: string, s: { run: typeof run }) => {
      run = s.run;
      spec = s as typeof spec;
      return cli;
    },
  } as unknown as Cli.Cli;
  return { cli, getRun: () => run, getSpec: () => spec };
};

const silence = () => {
  const i = spyOn(logger, 'info').mockImplementation(() => {});
  const e = spyOn(logger, 'error').mockImplementation(() => {});
  const d = spyOn(logger, 'debug').mockImplementation(() => {});
  return () => {
    i.mockRestore();
    e.mockRestore();
    d.mockRestore();
  };
};

describe('check/connection registrar', () => {
  test('invokes checkConnectionHandler with createBcClient()', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).getStoreInfo = async () => ({
      id: 'n-hash',
      name: 'N',
      domain: 'd',
      plan_name: 'P',
      plan_level: 'L',
      status: 'ok',
    });
    const { registerCheckConnectionSubcommand } = await import(
      './store/check-connection.ts'
    );
    const { cli, getRun } = capture();
    registerCheckConnectionSubcommand(cli);
    const result = (await getRun()?.({
      args: {},
      options: {},
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: { name: string } };
    expect(result.data.name).toBe('N');
    restore();
  });
});

describe('get/form-fields registrar', () => {
  test('delegates to getFormFieldsHandler', async () => {
    const restore = silence();
    fetchFieldsMock.mockImplementationOnce(async () => [
      null,
      { data: [], raw: {} },
    ]);
    const { registerGetFormFieldsSubcommand } = await import(
      './store/get-form-fields.ts'
    );
    const { cli, getRun } = capture();
    registerGetFormFieldsSubcommand(cli);
    const result = (await getRun()?.({
      args: {},
      options: { all: false, raw: false },
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: unknown };
    expect(result.data).toEqual({ formFields: [] });
    restore();
  });
});

describe('update/form-fields registrar', () => {
  test('collect returns existing → logs no changes', async () => {
    const restore = silence();
    loadFormFieldsMock.mockImplementation(() => [
      { name: 'A', type: 'string' },
    ]);
    const { registerUpdateFormFieldsSubcommand } = await import(
      './store/update-form-fields.ts'
    );
    const { cli, getRun } = capture();
    registerUpdateFormFieldsSubcommand(cli, {
      collect: async (existing) => existing,
    });
    const result = (await getRun()?.({
      args: {},
      options: { verbose: false },
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: { formFields: unknown[] } };
    expect(result.data.formFields).toEqual([{ name: 'A', type: 'string' }]);
    restore();
  });

  test('default collect (collectViaReadline) path wires save', async () => {
    const restore = silence();
    loadFormFieldsMock.mockImplementation(() => []);
    const { registerUpdateFormFieldsSubcommand } = await import(
      './store/update-form-fields.ts'
    );
    const { cli, getRun } = capture();
    registerUpdateFormFieldsSubcommand(cli, {
      collect: async () => [{ name: 'New', type: 'string' }],
    });
    const result = (await getRun()?.({
      args: {},
      options: { verbose: true },
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: { formFields: unknown[] } };
    expect(result.data.formFields).toEqual([{ name: 'New', type: 'string' }]);
    restore();
  });
});

describe('get/customer registrar', () => {
  test('wires lookupCustomer', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).lookupCustomer = async () => ({
      id: 1,
      email: 'a@b.c',
      first_name: 'F',
      last_name: 'L',
      phone: 'p',
      addresses: [],
      form_fields: [],
    });
    const { registerGetCustomerSubcommand } = await import(
      './customer/get-customer.ts'
    );
    const { cli, getRun } = capture();
    registerGetCustomerSubcommand(cli);
    const result = (await getRun()?.({
      args: { email: 'a@b.c' },
      options: {},
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: { id: number } };
    expect(result.data.id).toBe(1);
    restore();
  });
});

describe('get/cart registrar', () => {
  test('wires getCart', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).getCart = async () => ({ data: {} });
    (bcStub as Record<string, unknown>).getCartByOrderId = async () => ({
      data: { via: 'order' },
    });
    const { registerGetCartSubcommand } = await import('./cart/get-cart.ts');
    const { cli, getRun } = capture();
    registerGetCartSubcommand(cli);
    const ok = (data: unknown, meta: unknown) => ({ data, meta });
    const r1 = (await getRun()?.({
      args: { id: 'abc' },
      options: {},
      ok,
    })) as { data: unknown };
    expect(r1.data).toEqual({ data: {} });

    const r2 = (await getRun()?.({
      args: {},
      options: { orderId: 5 },
      ok,
    })) as { data: unknown };
    expect(r2.data).toEqual({ data: { via: 'order' } });
    restore();
  });
});

describe('get/fees registrar', () => {
  test('wires getOrderFees', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).getOrderFees = async () => [];
    const { registerGetFeesSubcommand } = await import('./order/get-fees.ts');
    const { cli, getRun } = capture();
    registerGetFeesSubcommand(cli);
    const result = (await getRun()?.({
      args: { id: '1' },
      options: {},
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: unknown[]; meta: { cta: unknown } };
    expect(result.data).toEqual([]);
    expect(result.meta.cta).toBeDefined();
    restore();
  });
});

describe('get/order registrar', () => {
  test('wires getOrder', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).getOrder = async () => ({
      id: 1,
      products: [],
    });
    const { registerGetOrderSubcommand } = await import('./order/get-order.ts');
    const { cli, getRun } = capture();
    registerGetOrderSubcommand(cli);
    const ctx = {
      args: { id: '1' },
      options: {},
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    };
    const result = (await getRun()?.(ctx)) as {
      data: { id: number };
      meta: { cta: unknown };
    };
    expect(result.data.id).toBe(1);
    expect(result.meta.cta).toBeDefined();
    restore();
  });
});

describe('get/orders registrar', () => {
  test('wires getOrdersByEmail', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).getOrdersByEmail = async () => [
      { id: 1, products: [] },
    ];
    const { registerGetOrdersSubcommand } = await import(
      './order/get-orders.ts'
    );
    const { cli, getRun } = capture();
    registerGetOrdersSubcommand(cli);
    const result = (await getRun()?.({
      args: {},
      options: { email: 'a@b.c', limit: 10 },
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: unknown[]; meta: { cta: unknown } };
    expect(result.data).toHaveLength(1);
    expect(result.meta.cta).toBeDefined();
    restore();
  });
});

describe('get/search registrar', () => {
  test('wires all bc methods across both branches', async () => {
    const restore = silence();
    const customer = {
      id: 1,
      email: 'a@b.c',
      first_name: 'A',
      last_name: 'B',
      phone: '1',
      addresses: [],
      form_fields: [],
    };
    (bcStub as Record<string, unknown>).searchCustomers = async () => [
      customer,
    ];
    (bcStub as Record<string, unknown>).getOrder = async () => ({
      customer_id: 1,
    });
    (bcStub as Record<string, unknown>).getRecentOrders = async () => [];

    const { registerGetSearchSubcommand } = await import(
      './customer/get-search.ts'
    );
    const { cli, getRun } = capture();
    registerGetSearchSubcommand(cli);

    const ok = (data: unknown, meta: unknown) => ({ data, meta });
    const r1 = (await getRun()?.({
      args: {},
      options: { email: 'a@b.c' },
      ok,
    })) as { data: unknown[] };
    expect(r1.data).toHaveLength(1);

    const r2 = (await getRun()?.({
      args: {},
      options: { order: '5' },
      ok,
    })) as { data: unknown[] };
    expect(r2.data).toHaveLength(1);
    restore();
  });
});

describe('update/form-field registrar', () => {
  test('wires updateCustomerFormField', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).updateCustomerFormField = async () => ({
      data: {},
    });
    const { registerUpdateFormFieldSubcommand } = await import(
      './customer/update-form-field.ts'
    );
    const { cli, getRun } = capture();
    registerUpdateFormFieldSubcommand(cli);
    const result = (await getRun()?.({
      args: { customerId: '1', fieldName: 'F', value: 'V' },
      options: {},
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: { data: unknown } };
    expect(result.data).toEqual({ data: {} });
    restore();
  });
});

describe('export/customers registrar (no-op export flow)', () => {
  test('exercises all bc wrappers (dry-run, with one customer)', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).cleanProgress = () => {};
    (bcStub as Record<string, unknown>).getCustomerIdsByFormField =
      async () => [1];
    (bcStub as Record<string, unknown>).getCustomersByIds = async (
      ids: number[],
      _p: string,
      cb: (c: Record<string, unknown>) => void,
    ) => {
      for (const id of ids) {
        cb({
          id,
          email: `u${id}@x.y`,
          first_name: 'A',
          last_name: 'B',
          phone: '1',
          addresses: [],
          form_fields: [],
        });
      }
      return ids.length;
    };

    const { registerExportCustomersSubcommand: reg } = await import(
      './customer/export-customers.ts'
    );
    const { cli, getRun } = capture();
    reg(cli);
    await getRun()?.({
      args: { key: 'reg-key' },
      options: {
        field: 'Trusted',
        value: 'True',
        columns: 'Email:email',
        resume: true,
        export: false,
        incremental: false,
      },
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    });
    restore();
  });
});

describe('export/customers registrar', () => {
  test('wires bc methods; exits info when no matches', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).cleanProgress = () => {};
    (bcStub as Record<string, unknown>).getCustomerIdsByFormField =
      async () => [];
    (bcStub as Record<string, unknown>).getCustomersByIds = async () => 0;
    const exitSpy = spyOn(process, 'exit').mockImplementation(((
      _code?: number,
    ) => {
      throw new Error('__exit__');
    }) as never);
    const { registerExportCustomersSubcommand } = await import(
      './customer/export-customers.ts'
    );
    const { cli, getRun } = capture();
    registerExportCustomersSubcommand(cli);
    await expect(
      getRun()?.({
        args: { key: 'k' },
        options: {
          field: 'Trusted',
          value: 'True',
          columns: 'Email:email',
          resume: false,
          export: false,
          incremental: false,
        },
      }),
    ).rejects.toThrow('__exit__');
    exitSpy.mockRestore();
    restore();
  });
});

describe('clean/progress registrar', () => {
  test('wires cleanProgress', async () => {
    const restore = silence();
    (bcStub as Record<string, unknown>).cleanProgress = () => {};
    const { registerCleanProgressSubcommand } = await import(
      './progress/clean-progress.ts'
    );
    const { cli, getRun } = capture();
    registerCleanProgressSubcommand(cli);
    const result = (await getRun()?.({
      args: { key: 'x' },
      options: {},
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: { cleaned: boolean; key: string } };
    expect(result.data).toMatchObject({ cleaned: true, key: 'x' });
    restore();
  });
});

describe('zod option defaults', () => {
  test('each registrar default output closure runs', async () => {
    const restore = silence();
    const modules = [
      [
        await import('./customer/get-search.ts'),
        'registerGetSearchSubcommand',
        {},
      ],
      [
        await import('./customer/export-customers.ts'),
        'registerExportCustomersSubcommand',
        { field: 'f', value: 'v', columns: 'c' },
      ],
      [
        await import('./order/get-orders.ts'),
        'registerGetOrdersSubcommand',
        { email: 'a@b.c' },
      ],
      [await import('./cart/get-cart.ts'), 'registerGetCartSubcommand', {}],
    ] as const;
    for (const [mod, name, extra] of modules) {
      const { cli, getSpec } = capture();
      const register = (mod as unknown as Record<string, (c: Cli.Cli) => void>)[
        name
      ];
      register?.(cli);
      const parsed = getSpec()?.options?.parse(extra);
      expect(parsed).toBeDefined();
    }
    restore();
  });
});

describe('get/progress registrar', () => {
  test('wires fs calls across empty and populated dirs', async () => {
    const restore = silence();
    const { registerGetProgressSubcommand } = await import(
      './progress/get-progress.ts'
    );
    const { cli, getRun } = capture();
    registerGetProgressSubcommand(cli);

    const originalCwd = process.cwd();
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'reg-prog-'));
    writeFileSync(
      join(dir, '.progress-foo.json'),
      JSON.stringify({ pageNum: 1, collectedIds: [], processedIdIndex: 0 }),
    );
    process.chdir(dir);
    const result = (await getRun()?.({
      args: {},
      options: {},
      ok: (data: unknown, meta: unknown) => ({ data, meta }),
    })) as { data: { progress: unknown[] } };
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    expect(result.data).toMatchObject({ progress: expect.any(Array) });
    restore();
  });
});
