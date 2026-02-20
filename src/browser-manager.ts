import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export type ProxyConfig = NonNullable<Parameters<typeof chromium.launch>[0]>['proxy'];

export class BrowserManager {
  private browser: Browser | undefined;

  public constructor(
    private readonly headless: boolean,
    private readonly proxy?: ProxyConfig,
  ) {}

  public async getContext(): Promise<BrowserContext> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.headless,
        ...(this.proxy ? { proxy: this.proxy } : {}),
      });
    }

    return this.browser.newContext();
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }
  }
}

export const gotoPage = async (page: Page, url: string, timeoutMs: number): Promise<void> => {
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });

  const status = response?.status() ?? 0;
  if (status >= 400) {
    throw new Error(`Navigation failed ${status} for ${url}`);
  }
};
