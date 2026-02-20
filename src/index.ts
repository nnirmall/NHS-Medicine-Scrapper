import { Command } from 'commander';

import { config } from './config.js';
import { logger } from './logger.js';
import { NHSMedicinesScraper } from './scraper.js';

// We want to make proper cli that is self documenting.
const program = new Command();

program
  .name('nhs-medicines-scraper')
  .description('Scrape NHS medicines pages')
  .option('-l, --limit <number>', 'max medicines to scrape', Number)
  .option('-s, --slug <slug>', 'single medicine slug to scrape')
  .option('-p, --parallel-tabs <number>', 'number of parallel pages', Number)
  .option('--headless <boolean>', 'run browser in headless mode', (value) => value === 'true')
  .option('--hard-refresh', 're-download medicines even if cached')
  .option('--proxy-server <url>', 'proxy server URL, example: http://host:port')
  .option('--proxy-username <username>', 'proxy username')
  .option('--proxy-password <password>', 'proxy password')
  .option('--proxy-bypass <list>', 'proxy bypass list, example: .internal,.local')
  .action(async (options) => {
    const scraper = new NHSMedicinesScraper(logger, config);
    const summary = await scraper.run({
      limit: options.limit,
      slug: options.slug,
      parallelTabs: options.parallelTabs,
      headless: options.headless,
      hardRefresh: options.hardRefresh,
      proxyServer: options.proxyServer,
      proxyUsername: options.proxyUsername,
      proxyPassword: options.proxyPassword,
      proxyBypass: options.proxyBypass,
    });

    logger.info(summary, 'Done');
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.fatal({ error }, 'Unhandled failure');
  process.exit(1);
});
