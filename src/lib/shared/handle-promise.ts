export const handlePromise = async <T>(
  promise: Promise<T>,
): Promise<[Error, null] | [null, T]> => {
  return promise
    .then((data) => [null, data] as [null, T])
    .catch((error) => [error as Error, null] as [Error, null]);
};
