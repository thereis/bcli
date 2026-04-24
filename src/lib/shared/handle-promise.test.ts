import { expect, test } from 'bun:test';
import { handlePromise } from './handle-promise.ts';

test('handlePromise returns data on success', async () => {
  const [error, data] = await handlePromise(Promise.resolve('ok'));
  expect(error).toBeNull();
  expect(data).toBe('ok');
});

test('handlePromise returns error on failure', async () => {
  const [error, data] = await handlePromise(Promise.reject(new Error('fail')));
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toBe('fail');
  expect(data).toBeNull();
});
