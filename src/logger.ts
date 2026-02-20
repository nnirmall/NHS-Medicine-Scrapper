import pino from 'pino';

import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: null,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:mm/dd/yyyy hh:MM:ss TT',
      singleLine: true,
    },
  },
});
