import got, { type Got, type HTTPError } from 'got';
import type { z } from 'zod';
import { logger } from '../shared/logger.ts';
import { type PaginatedResponse, paginatedResponseSchema } from './schemas.ts';

type Params = Record<string, string | number | boolean | undefined>;

type V3Request<T> = {
  path: string;
  params?: Params;
  schema: z.ZodType<T>;
};

type V2Request<T> = {
  path: string;
  params?: Params;
  schema: z.ZodType<T>;
};

type RawRequest = {
  path: string;
  params?: Params;
};

const buildUrl = (base: string, path: string, params?: Params) => {
  const url = `${base}${path}`;
  if (!params) return url;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }

  const qs = searchParams.toString();
  return qs ? `${url}?${qs}` : url;
};

export class BcHttpClient {
  private api: Got;
  readonly v3: string;
  readonly v2: string;

  constructor(storeHash: string, accessToken: string) {
    this.v3 = `https://api.bigcommerce.com/stores/${storeHash}/v3`;
    this.v2 = `https://api.bigcommerce.com/stores/${storeHash}/v2`;

    this.api = got.extend({
      headers: {
        'X-Auth-Token': accessToken,
        Accept: 'application/json',
      },
      retry: {
        limit: 5,
        statusCodes: [429],
        calculateDelay: ({ error, computedValue }) => {
          if (!computedValue) return 0;
          const res = (error as HTTPError)?.response;
          const retryMs = Number(
            res?.headers?.['x-rate-limit-time-reset-ms'] || 1500,
          );
          logger.debug(`Rate limited, retrying in ${retryMs}ms...`);
          return retryMs;
        },
      },
    });
  }

  async getV3<T>(req: V3Request<T>): Promise<PaginatedResponse<T>> {
    const url = buildUrl(this.v3, req.path, req.params);
    const raw = await this.api.get(url).json<unknown>();
    return paginatedResponseSchema(req.schema).parse(raw);
  }

  async getV3Raw(req: RawRequest): Promise<unknown> {
    const url = buildUrl(this.v3, req.path, req.params);
    return this.api.get(url).json<unknown>();
  }

  async putV3Raw<T>(req: RawRequest & { body: unknown }): Promise<T> {
    const url = buildUrl(this.v3, req.path, req.params);
    return this.api
      .put(url, {
        json: req.body,
        headers: { 'Content-Type': 'application/json' },
      })
      .json<T>();
  }

  async getV2<T>(req: V2Request<T>): Promise<T> {
    const url = buildUrl(this.v2, req.path, req.params);
    const raw = await this.api.get(url).json<unknown>();
    return req.schema.parse(raw);
  }

  async getV2Raw<T>(req: RawRequest): Promise<T> {
    const url = buildUrl(this.v2, req.path, req.params);
    return this.api.get(url).json<T>();
  }

  async getV2NoRetry<T>(req: V2Request<T>): Promise<T> {
    const url = buildUrl(this.v2, req.path, req.params);
    const raw = await this.api
      .get(url, { retry: { limit: 0 } })
      .json<unknown>();
    return req.schema.parse(raw);
  }
}
