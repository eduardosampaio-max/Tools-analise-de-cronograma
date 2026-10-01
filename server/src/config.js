import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const envPath = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(serverRoot, '.env');

dotenv.config({ path: envPath });

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const driveMode = (process.env.DRIVE_MODE || 'local').toLowerCase().trim();
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(serverRoot, 'data');

export const config = {
  envPath,
  serverRoot,
  dataDir,
  port: num('PORT', 3001),
  driveMode,
  localRoots: {
    RESIDENCIAL: process.env.LOCAL_ROOT_RESIDENCIAL || 'G:\\Drives compartilhados\\2_RESIDENCIAL',
    CORPORATIVO: process.env.LOCAL_ROOT_CORPORATIVO || 'G:\\Drives compartilhados\\3_CORPORATIVO',
    PREDIAL: process.env.LOCAL_ROOT_PREDIAL || 'G:\\Drives compartilhados\\4_PREDIAL',
  },
  google: {
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    roots: {
      RESIDENCIAL: process.env.GOOGLE_ROOT_RESIDENCIAL_ID || '',
      CORPORATIVO: process.env.GOOGLE_ROOT_CORPORATIVO_ID || '',
      PREDIAL: process.env.GOOGLE_ROOT_PREDIAL_ID || '',
    },
    rootNames: {
      RESIDENCIAL: '2_RESIDENCIAL',
      CORPORATIVO: '3_CORPORATIVO',
      PREDIAL: '4_PREDIAL',
    },
  },

  ocr: {
    enabled: String(process.env.OCR_ENABLED || 'true').toLowerCase() !== 'false',
    languages: process.env.OCR_LANGS || 'por+eng',
    pdfMode: (process.env.OCR_PDF_MODE || 'always').toLowerCase(),
    pdfMaxPages: Math.max(0, num('OCR_PDF_MAX_PAGES', 0)),
    pdfScale: Math.max(1, num('OCR_PDF_SCALE', 1.8)),
    pdfNativeCharsPerPage: Math.max(20, num('OCR_PDF_NATIVE_CHARS_PER_PAGE', 120)),
    maxEmbeddedImages: Math.max(0, num('OCR_MAX_EMBEDDED_IMAGES', 0)),
    maxImageBytes: Math.max(1, num('OCR_MAX_IMAGE_MB', 20)) * 1024 * 1024,
    timeoutMs: Math.max(30, num('OCR_TIMEOUT_SECONDS', 180)) * 1000,
    retryAttempts: Math.max(1, Math.min(5, num('OCR_RETRY_ATTEMPTS', 3))),
    retryScale: Math.max(1, num('OCR_RETRY_SCALE', 1.35)),
    requiredForVisual: String(process.env.OCR_REQUIRED_FOR_VISUAL || 'true').toLowerCase() !== 'false',
  },
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-5.6-luna',
    fallbackModels: String(process.env.OPENROUTER_FALLBACK_MODELS || '').split(',').map(x=>x.trim()).filter(Boolean),
    siteUrl: process.env.OPENROUTER_SITE_URL || 'http://localhost:5173',
    appName: process.env.OPENROUTER_APP_NAME || 'TOOLS Análise de Cronograma',
    requestTimeoutMs: Math.max(60, num('OPENROUTER_REQUEST_TIMEOUT_SECONDS', 900)) * 1000,
    maxOutputTokens: Math.max(2048, num('OPENROUTER_MAX_OUTPUT_TOKENS', 30000)),
    requireParameters: String(process.env.OPENROUTER_REQUIRE_PARAMETERS || 'true').toLowerCase() !== 'false',
    allowProviderFallbacks: String(process.env.OPENROUTER_ALLOW_PROVIDER_FALLBACKS || 'true').toLowerCase() !== 'false',
    structuredOutputMode: (process.env.OPENROUTER_STRUCTURED_OUTPUT_MODE || 'auto').toLowerCase(),
    contextSafetyMarginTokens: Math.max(16000, num('OPENROUTER_CONTEXT_SAFETY_MARGIN_TOKENS', 64000)),
    singleCallSafeInputTokens: Math.max(100000, num('OPENROUTER_SINGLE_CALL_SAFE_INPUT_TOKENS', 650000)),
    canonicalChunkTargetTokens: Math.max(50000, num('OPENROUTER_CANONICAL_CHUNK_TARGET_TOKENS', 300000)),
    canonicalEvidenceMaxTokens: Math.max(100000, num('OPENROUTER_CANONICAL_EVIDENCE_MAX_TOKENS', 500000)),
  },
  maxFileBytes: num('MAX_FILE_MB', 250) * 1024 * 1024,
  fileReadTimeoutMs: Math.max(15, num('FILE_READ_TIMEOUT_SECONDS', 120)) * 1000,
  fileWorkerTimeoutMs: Math.max(60, num('FILE_WORKER_TIMEOUT_SECONDS', 300)) * 1000, // compatibilidade legado
  fileWorkerIdleTimeoutMs: Math.max(60, num('FILE_WORKER_IDLE_TIMEOUT_SECONDS', num('FILE_WORKER_TIMEOUT_SECONDS', 300))) * 1000,
  fileWorkerHardTimeoutMs: Math.max(300, num('FILE_WORKER_HARD_TIMEOUT_SECONDS', 1800)) * 1000,
  fileExtractionTimeoutMs: Math.max(60, num('FILE_EXTRACTION_TIMEOUT_SECONDS', 1200)) * 1000, // legado/compatibilidade
  aiChunkChars: Math.max(8000, num('AI_CHUNK_CHARS', 28000)),
  aiCharsPerTokenEstimate: Math.max(1.8, num('AI_CHARS_PER_TOKEN_ESTIMATE', 2.5)),
  aiAuxSnippetChars: Math.max(2000, num('AI_AUX_SNIPPET_CHARS', 6500)),
  aiMaxAuxDocuments: Math.max(5, num('AI_MAX_AUX_DOCUMENTS', 30)),
  extractionConcurrency: Math.max(1, num('EXTRACTION_CONCURRENCY', 1)),
  aiConcurrency: Math.max(1, num('AI_CONCURRENCY', 1)),
  autoSync: {
    enabled: String(process.env.AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false',
    timezone: process.env.AUTO_SYNC_TIMEZONE || 'America/Sao_Paulo',
    pollSeconds: Math.max(15, num('AUTO_SYNC_POLL_SECONDS', 30)),
    graceMinutes: Math.max(1, Math.min(180, num('AUTO_SYNC_GRACE_MINUTES', 30))),
    preAnalysisRefresh: String(process.env.AUTO_SYNC_BEFORE_ANALYSIS || 'true').toLowerCase() !== 'false',
  },
  databasePath: process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : path.join(dataDir, 'cronograma.sqlite'),
  extractionDir: path.join(dataDir, 'extractions'),
  blobsDir: path.join(dataDir, 'blobs'),
  snapshotsDir: path.join(dataDir, 'snapshots'),
};
