import pino from 'pino';
import pretty from 'pino-pretty';

type LogFn = (message: string, data?: unknown) => void;

export type Logger = {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  setVerbose: (verbose: boolean) => void;
};

const stream = pretty({ ignore: 'pid,hostname' });

const createPino = (verbose: boolean) =>
  pino({ level: verbose ? 'debug' : 'info' }, stream);

const make =
  (pinoLogger: pino.Logger, level: pino.Level): LogFn =>
  (message, data) => {
    if (data !== undefined) {
      pinoLogger[level]({ data }, message);
    } else {
      pinoLogger[level](message);
    }
  };

const wrap = (pinoLogger: pino.Logger): Logger => ({
  debug: make(pinoLogger, 'debug'),
  info: make(pinoLogger, 'info'),
  warn: make(pinoLogger, 'warn'),
  error: make(pinoLogger, 'error'),
  fatal: make(pinoLogger, 'fatal'),
  setVerbose: (verbose) => {
    pinoLogger.level = verbose ? 'debug' : 'info';
  },
});

export const createLogger = (verbose = false): Logger =>
  wrap(createPino(verbose));

export const logger = createLogger();

export const stdout = (data: string) => {
  process.stdout.write(`${data}\n`);
};
