import dotenv from 'dotenv';
import { z } from 'zod';

import type { RunOptions } from './types.js';

// latest node js come with env support, we won't need it in future, but lets add for backward compatibility
dotenv.config();

// Use zod to validate env variables. Env variables some times cause huge problems are they are strings by default and can be missing etc..
const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    PARALLEL_TABS: z.coerce.number().int().nonnegative().default(4),
    HEADLESS: z.stringbool().default(true),
    NAVIGATION_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30000),
    RETRY_ATTEMPTS: z.coerce.number().int().nonnegative().default(3),
    RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(750),
    SCRAPE_LIMIT: z.coerce.number().int().nonnegative().default(0),
    OUTPUT_DIR: z.string().default('./data'),
  })
  .parse(process.env);

// our fav main config object.
export const config = {
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  parallelTabs: env.PARALLEL_TABS,
  headless: env.HEADLESS,
  navigationTimeoutMs: env.NAVIGATION_TIMEOUT_MS,
  retryAttempts: env.RETRY_ATTEMPTS,
  retryDelayMs: env.RETRY_DELAY_MS,
  scrapeLimit: env.SCRAPE_LIMIT,
  outputDir: env.OUTPUT_DIR,
} as const;

// compile time typesafety for config object, so we can use it across the codebase with proper types.
export type AppConfig = typeof config;

type ResolvedRunOptions = {
  targetLimit: number;
  targetSlug: string | undefined;
  parallelTabs: number;
  headless: boolean;
  hardRefresh: boolean;
};

export const resolveRunOptions = (
  options: RunOptions,
  appConfig: AppConfig = config,
): ResolvedRunOptions => ({
  targetLimit: options.limit ?? appConfig.scrapeLimit,
  targetSlug: options.slug,
  parallelTabs: Math.max(1, options.parallelTabs ?? appConfig.parallelTabs),
  headless: options.headless ?? appConfig.headless,
  hardRefresh: options.hardRefresh ?? false,
});
