# NHS Data Extractor

Extracts the NHS medications list.

## Features

- Production-ready
- Performant due to caching (can be overridden using flags)
- Retry mechanism
- Ability to use proxies (supports playwright native proxy)
- Properly tested using vitest
- Improved logging
- Follows proper design patterns and SOLID principles as much as possible
- Focus on readable code
- Config validation using Zod
- Snapshot testing to ensure pages haven't changed
- Follows the 12-Factor App approach (https://12factor.net/): single codebase, managed dependencies, env-driven config, proper logging, and dev/prod parity
- Parallel tabs
- Uses the latest Node.js and Playwright
- Uses `p-queue` and `p-retry`
- Docker support
- Dependency checks to ensure no vulnerable packages are used
- Uses Xvfb to run in headful mode on Linux to bypass display issues
- Follows Arrange–Act–Assert in tests
- Parallel test execution
- Github action for automated linting and snapshot testing.

## Future Plan

- Did not use the raw request pattern because Playwright/Puppeteer was suggested. Puppeteer is maintained by Google, Playwright by Microsoft. For this NHS website, simple requests with Cheerio should also work.
- Use agentic coding (e.g., ChatGPT Mini) to scrape highly dynamic pages
- Add OpenTelemetry
- Proper CI/CD
- Ability to update the script at runtime
- Expose MCP so chatbots can consume the medication data
- Add search by indexing with Meilisearch
- Build a frontend in Next.js to make it user-friendly

## Usage

Please install the node package using `pnpm i`. After that you can run scraper using `pnpm scrape`


```
pnpm scrape [options]

- -l, --limit <number>: max medicines to scrape
- -s, --slug <slug>: scrape only one medicine slug
- -p, --parallel-tabs <number>: number of parallel pages
- --headless <boolean>: browser mode (true or false)
- --hard-refresh: re-download even if cached
- --proxy-server <url>: proxy server (example: http://host:port)
- --proxy-username <username>: proxy username
- --proxy-password <password>: proxy password
- --proxy-bypass <list>: bypass list (example: .internal,.local)
- -h, --help: show help

Defaults/behavior:

- --limit: defaults to SCRAPE_LIMIT env (default 0, meaning no limit)
- --parallel-tabs: defaults to PARALLEL_TABS env (default 4)
- --headless: defaults to HEADLESS env (default true)
- --hard-refresh: defaults to false (cache-aware by default)

Example:

pnpm scrape --slug varenicline --limit 1 --parallel-tabs 2 --headless true
```
