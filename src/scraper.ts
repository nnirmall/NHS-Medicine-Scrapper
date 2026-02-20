import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

import PQueue from 'p-queue';
import pRetry from 'p-retry';
import type { Logger } from 'pino';
import type { BrowserContext, Page } from 'playwright';

import { BrowserManager, gotoPage } from './browser-manager.js';
import { config, resolveRunOptions, type AppConfig } from './config.js';
import { createProxyConfig } from './proxies.js';
import type {
  ContentSection,
  Medicine,
  MedicineCommonQuestions,
  MedicineContentPage,
  MedicineTask,
  OutputMetadataEntry,
  RunOptions,
  ScrapeSummary,
} from './types.js';
import { getText, prepareOutputStore, type OutputStore } from './utils.js';

const NHS_BASE_URL = 'https://www.nhs.uk';

type ScrapeState = {
  succeeded: number;
  completed: number;
  failed: number;
};

type LandingData = {
  name: string;
  brandNames: string[];
  description: string;
};

type SubpageUrls = {
  aboutUrl: string;
  dosageUrl?: string;
  sideEffectsUrl?: string;
  pregnancyUrl?: string;
  interactionsUrl?: string;
  questionsUrl?: string;
};

type ScrapedPages = {
  about: Medicine['about'];
  dosage?: MedicineContentPage;
  sideEffects?: MedicineContentPage;
  pregnancy?: MedicineContentPage;
  interactions?: MedicineContentPage;
  commonQuestions?: MedicineCommonQuestions;
};

export class NHSMedicinesScraper {
  public constructor(
    private readonly logger: Logger,
    private readonly appConfig: AppConfig = config,
  ) {}

  public async run(options: RunOptions = {}): Promise<ScrapeSummary> {
    const runOptions = resolveRunOptions(options, this.appConfig);

    const browserManager = new BrowserManager(runOptions.headless, createProxyConfig(options));
    let context: BrowserContext | undefined;

    try {
      context = await browserManager.getContext();
      context.setDefaultTimeout(this.appConfig.navigationTimeoutMs);
      context.setDefaultNavigationTimeout(this.appConfig.navigationTimeoutMs);
      const allMedicines = await this.scrapeIndexFromContext(context);

      // we consider each medicine as task, but we only want to run a subset based on CLI options (e.g. --slug or --limit), so we apply those filters before the cache policy
      const selected = this.selectTasks(
        allMedicines,
        runOptions.targetSlug,
        runOptions.targetLimit,
      );

      // ensure output director is ready like we create folders etc..
      const outputStore = await prepareOutputStore(this.appConfig.outputDir);

      // skip medicines that are already cached, unless --hard-refresh is used
      const { tasksToRun, skipped } = await this.applyCachePolicy(
        selected,
        outputStore,
        runOptions.hardRefresh,
      );

      const totalQueued = tasksToRun.length;
      this.logger.info(
        {
          total: totalQueued,
          skipped,
          parallelTabs: runOptions.parallelTabs,
          slug: runOptions.targetSlug ?? null,
          hardRefresh: runOptions.hardRefresh,
        },
        'Starting medicine extraction',
      );

      const state: ScrapeState = {
        succeeded: 0,
        completed: 0,
        failed: 0,
      };

      // main extraction happens here, we run tasks with a concurrency limit and update the state as we go
      await this.runTaskQueue(
        context,
        tasksToRun,
        runOptions.parallelTabs,
        totalQueued,
        outputStore,
        state,
      );

      const summary: ScrapeSummary = {
        total: totalQueued,
        succeeded: state.succeeded,
        failed: state.failed,
        skipped,
        metadataPath: outputStore.metadataPath,
      };

      this.logger.info(summary, 'Extraction complete');
      return summary;
    } finally {
      if (context) {
        await context.close();
      }
      await browserManager.close();
    }
  }

  // set default timeouts & scrape index url
  private async scrapeIndexFromContext(context: BrowserContext): Promise<MedicineTask[]> {
    const page = await context.newPage();

    try {
      return await this.scrapeIndexUrl(page);
    } finally {
      await page.close();
    }
  }

  // apply CLI filters like --slug and --limit to the full list of medicines before we apply cache policy.
  private selectTasks(
    allMedicines: MedicineTask[],
    targetSlug: string | undefined,
    targetLimit: number,
  ): MedicineTask[] {
    const filtered = targetSlug
      ? allMedicines.filter((item) => item.slug === targetSlug)
      : allMedicines;
    return targetLimit > 0 ? filtered.slice(0, targetLimit) : filtered;
  }

  private async applyCachePolicy(
    tasks: MedicineTask[],
    outputStore: OutputStore,
    hardRefresh: boolean,
  ): Promise<{ tasksToRun: MedicineTask[]; skipped: number }> {
    if (hardRefresh) {
      return { tasksToRun: tasks, skipped: 0 };
    }

    const cachedSlugs = await this.getCachedSlugs(outputStore.outputDir, outputStore.metadata);
    let skipped = 0;

    const tasksToRun = tasks.filter((task) => {
      if (!cachedSlugs.has(task.slug)) {
        return true;
      }

      skipped += 1;
      return false;
    });

    return { tasksToRun, skipped };
  }

  private async getCachedSlugs(
    outputDir: string,
    metadata: OutputMetadataEntry[],
  ): Promise<Set<string>> {
    const cachedSlugs = new Set<string>();

    for (const item of metadata) {
      try {
        await access(path.resolve(outputDir, item.medicineFilePath));
        cachedSlugs.add(item.slug);
      } catch {}
    }

    return cachedSlugs;
  }

  // use p-queue library to orchestrace medicines extractions.
  private async runTaskQueue(
    context: BrowserContext,
    tasksToRun: MedicineTask[],
    parallelTabs: number,
    totalQueued: number,
    outputStore: OutputStore,
    state: ScrapeState,
  ): Promise<void> {
    const queue = new PQueue({
      concurrency: Math.min(parallelTabs, Math.max(1, totalQueued)),
    });

    for (const [index, task] of tasksToRun.entries()) {
      queue.add(() =>
        this.processMedicineTask(context, task, index, totalQueued, outputStore, state),
      );
    }

    await queue.onIdle();
  }

  private async processMedicineTask(
    context: BrowserContext,
    task: MedicineTask,
    index: number,
    totalQueued: number,
    outputStore: OutputStore,
    state: ScrapeState,
  ): Promise<void> {
    const current = index + 1;
    const medicineLogger = this.logger.child({
      slug: task.slug,
      current,
      total: totalQueued,
    });

    const page = await context.newPage();

    try {
      const medicine = await this.retryScrapeMedicine(
        page,
        task,
        medicineLogger,
        current,
        totalQueued,
      );
      state.succeeded += 1;

      await this.persistMedicine(task, medicine, outputStore);
      medicineLogger.info(`Medicine extracted (${current} out of ${totalQueued})`);
    } catch (error) {
      state.failed += 1;
      medicineLogger.error(
        { error: error instanceof Error ? error.message : error },
        `Medicine extraction failed (${current} out of ${totalQueued})`,
      );
    } finally {
      state.completed += 1;
      this.logProgress(state, totalQueued);
      await page.close();
    }
  }

  private async retryScrapeMedicine(
    page: Page,
    task: MedicineTask,
    medicineLogger: Logger,
    current: number,
    totalQueued: number,
  ): Promise<Medicine> {
    let attempt = 0;

    return pRetry(
      () => {
        attempt += 1;
        if (attempt === 1) {
          medicineLogger.info(`Extracting medicine (${current} out of ${totalQueued})`);
        }

        return this.scrapeMedicine(page, task);
      },
      {
        retries: Math.max(0, this.appConfig.retryAttempts - 1),
        minTimeout: this.appConfig.retryDelayMs,
        maxTimeout: this.appConfig.retryDelayMs,
        factor: 1,
        randomize: false,
        onFailedAttempt: (error) => {
          medicineLogger.warn(
            {
              attempt: error.attemptNumber,
              retriesLeft: error.retriesLeft,
              error: error.error instanceof Error ? error.error.message : String(error.error),
            },
            'Retrying medicine extraction',
          );
        },
      },
    );
  }

  private logProgress(state: ScrapeState, totalQueued: number): void {
    if (state.completed % 25 !== 0 && state.completed !== totalQueued) {
      return;
    }

    this.logger.info(
      {
        completed: state.completed,
        total: totalQueued,
        succeeded: state.succeeded,
        failed: state.failed,
      },
      'Progress',
    );
  }

  // write medicine data to file and update metadata, we use a queue to serialize metadata
  private async persistMedicine(
    task: MedicineTask,
    medicine: Medicine,
    outputStore: OutputStore,
  ): Promise<void> {
    await outputStore.metadataWriteQueue.add(async () => {
      const medicineFilePath = path.join(
        outputStore.medicinesDir,
        `${this.toMedicineFileName(medicine)}.json`,
      );

      await writeFile(medicineFilePath, JSON.stringify(medicine, null, 2), 'utf-8');

      const relativeFilePath = path
        .relative(outputStore.outputDir, medicineFilePath)
        .split(path.sep)
        .join('/');

      this.upsertMetadata(outputStore.metadata, task.slug, medicine.name, relativeFilePath);
      await writeFile(
        outputStore.metadataPath,
        JSON.stringify(outputStore.metadata, null, 2),
        'utf-8',
      );
    });
  }

  private toMedicineFileName(medicine: Medicine): string {
    return medicine.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || medicine.slug;
  }

  private upsertMetadata(
    metadata: OutputMetadataEntry[],
    slug: string,
    medicineName: string,
    medicineFilePath: string,
  ): void {
    const existingIndex = metadata.findIndex((item) => item.slug === slug);

    const nextEntry: OutputMetadataEntry = {
      slug,
      medicineName,
      medicineFilePath,
    };

    if (existingIndex >= 0) {
      metadata[existingIndex] = nextEntry;
      return;
    }

    metadata.push(nextEntry);
  }

  private async scrapeIndexUrl(page: Page): Promise<MedicineTask[]> {
    await gotoPage(page, `${NHS_BASE_URL}/medicines/`, this.appConfig.navigationTimeoutMs);

    const hrefs = await page.locator('main a[href*="/medicines/"]').evaluateAll((elements) => {
      return elements
        .map((element) => element.getAttribute('href') ?? '')
        .filter((href) => href.length > 0);
    });

    const tasks = new Map<string, MedicineTask>();

    for (const href of hrefs) {
      const url = this.toIndexMedicineUrl(href);
      if (!url) continue;

      const slug = url.pathname.split('/').filter(Boolean)[1];
      if (!slug) continue;

      tasks.set(slug, { slug, url: url.toString() });
    }

    return [...tasks.values()];
  }

  private async scrapeMedicine(page: Page, task: MedicineTask): Promise<Medicine> {
    await gotoPage(page, task.url, this.appConfig.navigationTimeoutMs);

    const landing = await this.readLandingData(page, task);
    const medicineLinks = await this.extractMedicineLinks(page, task.slug);
    const { relatedConditions, usefulResources } = await this.extractRelatedLinks(page);
    const subpages = this.resolveSubpageUrls(medicineLinks, task.url);
    const pages = await this.scrapePages(page, subpages, landing.description);

    return this.composeMedicine(task, landing, pages, relatedConditions, usefulResources);
  }

  private async readLandingData(page: Page, task: MedicineTask): Promise<LandingData> {
    const title = (await getText(page, 'main h1')) ?? task.slug;
    const description =
      (await this.getIntroDescription(page)) ?? (await getText(page, 'main h1 + p')) ?? '';
    const [name, brandNames] = this.parseBrandNames(title);

    return { name, brandNames, description };
  }

  private async extractMedicineLinks(page: Page, slug: string): Promise<string[]> {
    const navLinks = await page.locator('main a[href*="/medicines/"]').evaluateAll((elements) => {
      return elements
        .map((element) => element.getAttribute('href') ?? '')
        .filter((href) => href.length > 0);
    });

    const medicineBasePath = `/medicines/${slug}/`;
    return [...new Set(navLinks)]
      .map((href) => new URL(href, NHS_BASE_URL))
      .filter((url) => url.pathname.startsWith(medicineBasePath))
      .map((url) => url.toString());
  }

  private async extractRelatedLinks(page: Page): Promise<{
    relatedConditions: Medicine['relatedConditions'];
    usefulResources: Medicine['usefulResources'];
  }> {
    const allLinks = await page.locator('main a[href]').evaluateAll((elements) => {
      return elements
        .map((element) => ({
          label: element.textContent?.trim() ?? '',
          href: element.getAttribute('href') ?? '',
        }))
        .filter((item) => item.label.length > 0 && item.href.length > 0);
    });

    const normalized = allLinks.map((item) => ({
      label: item.label,
      url: new URL(item.href, NHS_BASE_URL).toString(),
    }));

    return {
      relatedConditions: normalized.filter((item) => item.url.includes('/conditions/')),
      usefulResources: normalized.filter(
        (item) => !item.url.includes('/medicines/') && !item.url.includes('/conditions/'),
      ),
    };
  }

  private resolveSubpageUrls(medicineLinks: string[], fallbackUrl: string): SubpageUrls {
    const dosageUrl = this.findLink(medicineLinks, ['how-and-when', 'dosage']);
    const sideEffectsUrl = this.findLink(medicineLinks, ['side-effects']);
    const pregnancyUrl = this.findLink(medicineLinks, ['pregnancy', 'breastfeeding', 'fertility']);
    const interactionsUrl = this.findLink(medicineLinks, [
      'interactions',
      'other-medicines',
      'herbal',
    ]);
    const questionsUrl = this.findLink(medicineLinks, ['common-questions']);

    return {
      aboutUrl: this.findLink(medicineLinks, ['about']) ?? fallbackUrl,
      ...(dosageUrl ? { dosageUrl } : {}),
      ...(sideEffectsUrl ? { sideEffectsUrl } : {}),
      ...(pregnancyUrl ? { pregnancyUrl } : {}),
      ...(interactionsUrl ? { interactionsUrl } : {}),
      ...(questionsUrl ? { questionsUrl } : {}),
    };
  }

  private async scrapePages(
    page: Page,
    urls: SubpageUrls,
    fallbackDescription: string,
  ): Promise<ScrapedPages> {
    return {
      about: await this.scrapeAboutPage(page, urls.aboutUrl, fallbackDescription),
      ...(urls.dosageUrl ? { dosage: await this.scrapeContentPage(page, urls.dosageUrl) } : {}),
      ...(urls.sideEffectsUrl
        ? { sideEffects: await this.scrapeContentPage(page, urls.sideEffectsUrl) }
        : {}),
      ...(urls.pregnancyUrl
        ? { pregnancy: await this.scrapeContentPage(page, urls.pregnancyUrl) }
        : {}),
      ...(urls.interactionsUrl
        ? { interactions: await this.scrapeContentPage(page, urls.interactionsUrl) }
        : {}),
      ...(urls.questionsUrl
        ? { commonQuestions: await this.scrapeQuestionsPage(page, urls.questionsUrl) }
        : {}),
    };
  }

  private composeMedicine(
    task: MedicineTask,
    landing: LandingData,
    pages: ScrapedPages,
    relatedConditions: Medicine['relatedConditions'],
    usefulResources: Medicine['usefulResources'],
  ): Medicine {
    return {
      name: landing.name,
      slug: task.slug,
      url: task.url,
      brandNames: landing.brandNames,
      about: pages.about,
      ...(pages.dosage ? { dosage: pages.dosage } : {}),
      ...(pages.sideEffects ? { sideEffects: pages.sideEffects } : {}),
      ...(pages.pregnancy ? { pregnancy: pages.pregnancy } : {}),
      ...(pages.interactions ? { interactions: pages.interactions } : {}),
      ...(pages.commonQuestions ? { commonQuestions: pages.commonQuestions } : {}),
      relatedConditions,
      usefulResources,
      metadata: {
        scrapedAt: new Date().toISOString(),
        source: 'nhs',
      },
    };
  }

  private async scrapeAboutPage(
    page: Page,
    url: string,
    fallbackDescription: string,
  ): Promise<Medicine['about']> {
    await gotoPage(page, url, this.appConfig.navigationTimeoutMs);
    const content = await this.extractSections(page);

    const description =
      (await this.getIntroDescription(page)) ??
      (await getText(page, 'main h1 + p')) ??
      fallbackDescription;
    const keyFacts = content.find((section) => /key facts/i.test(section.heading))?.bullets ?? [];
    const usedFor =
      content.find((section) => /used for|what it/i.test(section.heading))?.bullets ?? [];

    const lastReviewed = await this.extractLastReviewed(page);
    const about: Medicine['about'] = {
      description,
      keyFacts,
      usedFor,
      content,
    };

    if (lastReviewed) about.lastReviewed = lastReviewed;
    return about;
  }

  private async getIntroDescription(page: Page): Promise<string | undefined> {
    const introParagraphs = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return [] as string[];

      const firstHeading = main.querySelector('h2, h3');
      return Array.from(main.querySelectorAll('p'))
        .filter((p) => !p.textContent?.includes('Last reviewed'))
        .filter((p) => {
          if (!firstHeading) return true;
          return (p.compareDocumentPosition(firstHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        })
        .map((p) => p.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .filter(Boolean);
    });

    return introParagraphs.length > 0 ? introParagraphs.join('\n\n') : undefined;
  }

  private async scrapeContentPage(page: Page, url: string): Promise<MedicineContentPage> {
    await gotoPage(page, url, this.appConfig.navigationTimeoutMs);
    const lastReviewed = await this.extractLastReviewed(page);
    const result: MedicineContentPage = {
      content: await this.extractSections(page),
    };

    if (lastReviewed) result.lastReviewed = lastReviewed;
    return result;
  }

  private async scrapeQuestionsPage(page: Page, url: string): Promise<MedicineCommonQuestions> {
    await gotoPage(page, url, this.appConfig.navigationTimeoutMs);

    const questions = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return [] as Array<{ question: string; answer: string }>;

      const accordionQuestions = Array.from(main.querySelectorAll('details'))
        .map((detail) => {
          const question =
            detail
              .querySelector('summary')
              ?.textContent?.replace(/\s+/g, ' ')
              .trim() ?? '';
          const answerParts = [
            ...Array.from(detail.querySelectorAll('p'))
              .map((p) => p.textContent?.replace(/\s+/g, ' ').trim() ?? '')
              .filter(Boolean),
            ...Array.from(detail.querySelectorAll('li'))
              .map((li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '')
              .filter(Boolean),
          ];
          return {
            question,
            answer: answerParts.join('\n'),
          };
        })
        .filter((item) => item.question.length > 0 && item.answer.length > 0);

      if (accordionQuestions.length > 0) {
        return accordionQuestions;
      }

      const headingSelector = 'h2, h3';
      return Array.from(main.querySelectorAll(headingSelector))
        .map((heading) => {
          const question = heading.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          const answerParts: string[] = [];
          let node = heading.nextElementSibling;

          while (node && !node.matches(headingSelector)) {
            if (node.matches('p')) {
              const text = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              if (text) answerParts.push(text);
            }

            if (node.matches('ul, ol')) {
              answerParts.push(
                ...Array.from(node.querySelectorAll('li'))
                  .map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '')
                  .filter(Boolean),
              );
            }

            node = node.nextElementSibling;
          }

          return {
            question,
            answer: answerParts.join('\n'),
          };
        })
        .filter(
          (item) =>
            item.question.length > 0 &&
            item.answer.length > 0 &&
            !item.question.toLowerCase().startsWith('more in'),
        );
    });

    const lastReviewed = await this.extractLastReviewed(page);
    const result: MedicineCommonQuestions = {
      questions,
    };

    if (lastReviewed) result.lastReviewed = lastReviewed;
    return result;
  }

  private async extractSections(page: Page): Promise<ContentSection[]> {
    return page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return [] as ContentSection[];

      const headingSelector = 'h2, h3';
      const headings = Array.from(main.querySelectorAll(headingSelector));

      return headings
        .map((heading) => {
          const section: ContentSection = {
            heading: heading.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            paragraphs: [],
            bullets: [],
          };

          let node = heading.nextElementSibling;
          while (node && !node.matches(headingSelector)) {
            if (node.matches('p')) {
              const text = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              if (text) section.paragraphs.push(text);
            }

            if (node.matches('ul, ol')) {
              const items = Array.from(node.querySelectorAll('li'))
                .map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '')
                .filter(Boolean);
              section.bullets.push(...items);
            }

            node = node.nextElementSibling;
          }

          return section;
        })
        .filter((section) => section.heading.length > 0);
    });
  }

  private async extractLastReviewed(page: Page): Promise<string | undefined> {
    const paragraphs = await page.locator('main p').allTextContents();
    const line = paragraphs.find((text) => text.includes('Last reviewed'));
    if (!line) return undefined;

    const match = line.match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
    if (!match) return undefined;

    const parsed = new Date(`${match[1]} UTC`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
  }

  private parseBrandNames(title: string): [string, string[]] {
    const cleaned = title.replace(/\s+/g, ' ').trim();
    const parts = cleaned.split(/\s+-\s+Other brand names:\s+/i);
    const left = parts[0] ?? cleaned;
    const right = parts[1];
    const brands: string[] = [];

    if (right) {
      brands.push(
        ...right
          .split(/,|\//)
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }

    const bracketMatch = left.match(/^(.*?)\((.*?)\)$/);
    if (!bracketMatch) return [left, [...new Set(brands)]];

    const [, rawName, rawBracketBrands] = bracketMatch;
    const name = (rawName ?? left).trim();
    brands.push(
      ...(rawBracketBrands ?? '')
        .split(/,|\//)
        .map((item) => item.trim())
        .filter(Boolean),
    );

    return [name, [...new Set(brands)]];
  }

  private findLink(links: string[], keywords: string[]): string | undefined {
    return links.find((link) => keywords.some((keyword) => link.includes(keyword)));
  }

  private toIndexMedicineUrl(value: string): URL | undefined {
    const url = new URL(value, NHS_BASE_URL);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'medicines' || parts.length !== 2) return undefined;
    const slug = parts[1];
    if (!slug) return undefined;

    url.pathname = `/medicines/${slug}/`;
    url.search = '';
    url.hash = '';
    return url;
  }
}
