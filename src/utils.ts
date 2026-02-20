import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import PQueue from 'p-queue';
import type { Page } from 'playwright';

import type { OutputMetadataEntry } from './types.js';

export type OutputStore = {
  outputDir: string;
  medicinesDir: string;
  metadataPath: string;
  metadata: OutputMetadataEntry[];
  metadataWriteQueue: PQueue;
};

// we parse metadata for caching and look ups
// we can ignore errors here, as if it isn't available we will always fetch latest one from nhs website.
const loadMetadata = async (metadataPath: string): Promise<OutputMetadataEntry[]> => {
  try {
    const raw = await readFile(metadataPath, 'utf-8');
    const items = JSON.parse(raw) as OutputMetadataEntry[];
    return items.map((item) => ({
      ...item,
      slug: item.slug || path.basename(item.medicineFilePath, '.json'),
    }));
  } catch {
    return [];
  }
};

export const prepareOutputStore = async (outputDirPath: string): Promise<OutputStore> => {
  const outputDir = path.resolve(outputDirPath);
  const medicinesDir = path.join(outputDir, 'medicines');
  const metadataPath = path.join(outputDir, 'metadata.json');

  await mkdir(medicinesDir, { recursive: true });

  return {
    outputDir,
    medicinesDir,
    metadataPath,
    metadata: await loadMetadata(metadataPath),
    metadataWriteQueue: new PQueue({ concurrency: 1 }),
  };
};

export const getText = async (page: Page, selector: string): Promise<string | undefined> => {
  const text = await page
    .locator(selector)
    .first()
    .textContent({ timeout: 1500 })
    .catch(() => null);
  return text?.trim() || undefined;
};
