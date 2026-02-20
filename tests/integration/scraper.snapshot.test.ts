import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import pino from 'pino';
import { describe, it } from 'vitest';

import { config } from '../../src/config.js';
import { NHSMedicinesScraper } from '../../src/scraper.js';
import type { Medicine, OutputMetadataEntry, ScrapeSummary } from '../../src/types.js';

type RunResult = {
  tempDir: string;
  summary: ScrapeSummary;
  medicine: Medicine;
};

const runMedicineScrape = async (slug: string): Promise<RunResult> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nhs-medicine-test-'));

  const scraper = new NHSMedicinesScraper(pino({ enabled: false }), {
    ...config,
    outputDir: tempDir,
  });

  const summary = await scraper.run({
    slug,
    limit: 1,
    parallelTabs: 3,
    headless: false,
    hardRefresh: true,
  });

  const metadataRaw = await readFile(path.resolve(tempDir, 'metadata.json'), 'utf-8');
  const metadata = JSON.parse(metadataRaw) as OutputMetadataEntry[];

  const entry = metadata.find((item) => item.slug === slug);
  if (!entry) {
    throw new Error(`Missing metadata entry for ${slug}`);
  }

  const medicineRaw = await readFile(path.resolve(tempDir, entry.medicineFilePath), 'utf-8');
  const medicine = JSON.parse(medicineRaw) as Medicine;

  return {
    tempDir,
    summary,
    medicine,
  };
};

const normalizeForSnapshot = (slug: string, summary: ScrapeSummary, medicine: Medicine) => ({
  slug,
  summary: {
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    skipped: summary.skipped,
  },
  medicine: {
    ...medicine,
    metadata: {
      source: medicine.metadata.source,
    },
  },
});

describe('real-browser medicine snapshots (AAA)', () => {
  it.concurrent('aciclovir snapshot', async ({ expect }) => {
    // Arrange
    const slug = 'aciclovir';

    // Act
    const result = await runMedicineScrape(slug);

    try {
      // Assert
      expect(normalizeForSnapshot(slug, result.summary, result.medicine)).toMatchSnapshot();
    } finally {
      await rm(result.tempDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.concurrent('amlodipine snapshot', async ({ expect }) => {
    // Arrange
    const slug = 'amlodipine';

    // Act
    const result = await runMedicineScrape(slug);

    try {
      // Assert
      expect(normalizeForSnapshot(slug, result.summary, result.medicine)).toMatchSnapshot();
    } finally {
      await rm(result.tempDir, { recursive: true, force: true });
    }
  }, 180_000);

  it.concurrent('varenicline snapshot', async ({ expect }) => {
    // Arrange
    const slug = 'varenicline';

    // Act
    const result = await runMedicineScrape(slug);

    try {
      // Assert
      expect(normalizeForSnapshot(slug, result.summary, result.medicine)).toMatchSnapshot();
    } finally {
      await rm(result.tempDir, { recursive: true, force: true });
    }
  }, 180_000);
});
