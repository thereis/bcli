import { logger } from './logger.ts';

export class HandlerExitError extends Error {
  readonly code: number;
  readonly kind: 'info' | 'error';

  constructor(
    message: string,
    opts: { code?: number; kind?: 'info' | 'error' } = {},
  ) {
    super(message);
    this.name = 'HandlerExitError';
    this.code = opts.code ?? 1;
    this.kind = opts.kind ?? 'error';
  }
}

export const exitWithError = (message: string, code = 1): never => {
  throw new HandlerExitError(message, { code, kind: 'error' });
};

export const exitWithInfo = (message: string, code = 0): never => {
  throw new HandlerExitError(message, { code, kind: 'info' });
};

export const runHandler = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HandlerExitError) {
      if (error.kind === 'info') {
        if (error.message) logger.info(error.message);
      } else if (error.message) {
        logger.error(error.message);
      }
      process.exit(error.code);
    }
    throw error;
  }
};
