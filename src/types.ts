export interface ContentSection {
  heading: string;
  paragraphs: string[];
  bullets: string[];
}

export interface RelatedCondition {
  label: string;
  url: string;
}

export interface UsefulResource {
  label: string;
  url: string;
}

export interface QuestionAnswer {
  question: string;
  answer: string;
}

export interface MedicineAbout {
  description: string;
  keyFacts: string[];
  usedFor: string[];
  content: ContentSection[];
  lastReviewed?: string;
}

export interface MedicineContentPage {
  content: ContentSection[];
  lastReviewed?: string;
}

export interface MedicineCommonQuestions {
  questions: QuestionAnswer[];
  lastReviewed?: string;
}

export interface Medicine {
  name: string;
  slug: string;
  url: string;
  brandNames: string[];
  about: MedicineAbout;
  dosage?: MedicineContentPage;
  sideEffects?: MedicineContentPage;
  pregnancy?: MedicineContentPage;
  interactions?: MedicineContentPage;
  commonQuestions?: MedicineCommonQuestions;
  relatedConditions: RelatedCondition[];
  usefulResources: UsefulResource[];
  metadata: {
    scrapedAt: string;
    source: 'nhs';
  };
}

export interface MedicineTask {
  slug: string;
  url: string;
}

export interface RunOptions {
  limit?: number;
  slug?: string;
  parallelTabs?: number;
  headless?: boolean;
  hardRefresh?: boolean;
  proxyServer?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  proxyBypass?: string;
}

export interface ScrapeSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  metadataPath: string;
}

export interface OutputMetadataEntry {
  slug: string;
  medicineName: string;
  medicineFilePath: string;
}
