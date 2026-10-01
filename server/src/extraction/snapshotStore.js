import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const EXTRACTOR_VERSION = '1.13-ocr-retry-download-v1';
const COMPATIBLE_EXTRACTOR_VERSIONS = [EXTRACTOR_VERSION, '1.10-isolated-worker-watchdog-v1'];

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(config.extractionDir, { recursive: true }),
    fs.mkdir(config.blobsDir, { recursive: true }),
    fs.mkdir(config.snapshotsDir, { recursive: true }),
  ]);
}

export function artifactKeyFor(file) {
  const raw = [EXTRACTOR_VERSION, file.source, file.id, file.modifiedTime, file.size, file.ext].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function artifactPath(key) {
  return path.join(config.extractionDir, `${key}.json.gz`);
}

function snapshotPath(id) {
  return path.join(config.snapshotsDir, `${id}.json`);
}

export async function hasArtifact(key) {
  try { await fs.access(artifactPath(key)); return true; } catch { return false; }
}

export async function saveArtifact(key, artifact) {
  await ensureDirs();
  const bytes = Buffer.from(JSON.stringify(artifact), 'utf8');
  const compressed = await gzipAsync(bytes, { level: 6 });
  const target = artifactPath(key);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, compressed);
  await fs.rename(temp, target);
  return { compressedBytes: compressed.length, jsonBytes: bytes.length };
}

export async function loadArtifact(key) {
  const compressed = await fs.readFile(artifactPath(key));
  const bytes = await gunzipAsync(compressed);
  return JSON.parse(bytes.toString('utf8'));
}

export async function saveBlob(key, ext, buffer) {
  await ensureDirs();
  const safeExt = (ext || '.bin').replace(/[^a-z0-9.]/gi, '') || '.bin';
  const target = path.join(config.blobsDir, `${key}${safeExt.startsWith('.') ? safeExt : `.${safeExt}`}`);
  await fs.writeFile(target, buffer);
  return target;
}

export async function loadBlob(blobPath) {
  if (!blobPath) throw new Error('Blob não disponível para este artefato.');
  return fs.readFile(blobPath);
}

export async function saveSnapshot(snapshot) {
  await ensureDirs();
  const target = snapshotPath(snapshot.id);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.rename(temp, target);
  return snapshot;
}

export async function loadSnapshot(id) {
  const text = await fs.readFile(snapshotPath(id), 'utf8');
  return JSON.parse(text);
}

export function publicArtifactInfo(artifact) {
  return {
    schemaVersion: artifact.schemaVersion,
    kind: artifact.kind,
    extractedBy: artifact.extractedBy,
    metrics: artifact.metrics || {},
    requiresVision: Boolean(artifact.requiresVision),
    machineReadable: true,
    contentHash: artifact.contentHash,
    sourcePreserved: Boolean(artifact.sourceBlobRef),
    preview: String(artifact.text || '').slice(0, 5000),
    ocr: artifact.ocr ? { enabled:Boolean(artifact.ocr.enabled), eligible:artifact.ocr.eligible !== false, notApplicable:Boolean(artifact.ocr.notApplicable), applied:Boolean(artifact.ocr.applied), complete:artifact.ocr.complete !== false, pending:Boolean(artifact.ocr.pending), interrupted:Boolean(artifact.ocr.interrupted), targetCount:artifact.ocr.targetCount ?? null, completedTargets:artifact.ocr.completedTargets ?? null, failedTargets:artifact.ocr.failedTargets ?? null, characters:artifact.ocr.characters || 0, error:artifact.ocr.error || null } : null,
    technicalSummary: artifact.technicalSummary || null,
    coverage: artifact.coverage || artifact.analysisCorpus?.coverage || null,
    corpusStats: artifact.analysisCorpus?.stats || null,
  };
}

export { EXTRACTOR_VERSION, COMPATIBLE_EXTRACTOR_VERSIONS };
