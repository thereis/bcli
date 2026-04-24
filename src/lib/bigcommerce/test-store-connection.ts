import { handlePromise } from '../shared/handle-promise.ts';
import type { StoreInfo } from './schemas.ts';

export const testStoreConnection = async (
  storeHash: string,
  accessToken: string,
): Promise<[Error, null] | [null, StoreInfo]> => {
  const url = `https://api.bigcommerce.com/stores/${storeHash}/v2/store`;
  const headers = {
    'X-Auth-Token': accessToken,
    Accept: 'application/json',
  };

  const [fetchError, res] = await handlePromise(fetch(url, { headers }));
  if (fetchError) {
    return [
      new Error('Could not connect to BigCommerce API. Check your network.'),
      null,
    ];
  }

  if (res.status === 401) {
    return [new Error('Authentication failed. Check your access token.'), null];
  }
  if (res.status === 404) {
    return [new Error('Store not found. Check your store hash.'), null];
  }
  if (!res.ok) {
    const body = await res.text();
    return [new Error(`API error ${res.status}: ${body}`), null];
  }

  const store = (await res.json()) as StoreInfo;
  return [null, store];
};
