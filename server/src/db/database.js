import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

let db;

function now() { return new Date().toISOString(); }
function bool(v) { return v ? 1 : 0; }
function text(v) { return v == null ? null : String(v); }

export function artifactIdFor(contentHash, extractorVersion, salt='') {
  return crypto.createHash('sha256').update(contentHash ? `${extractorVersion}|${contentHash}` : `${extractorVersion}|NOHASH|${salt}`).digest('hex');
}

export function initDatabase() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive:true });
  db = new DatabaseSync(config.databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 10000;

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area TEXT NOT NULL,
      obra TEXT NOT NULL,
      folder_path TEXT,
      source_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(area, obra, source_mode)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      content_hash TEXT,
      extractor_version TEXT NOT NULL,
      kind TEXT,
      coverage_status TEXT,
      public_json TEXT,
      json_gzip BLOB NOT NULL,
      json_bytes INTEGER NOT NULL DEFAULT 0,
      compressed_bytes INTEGER NOT NULL DEFAULT 0,
      corpus_characters INTEGER NOT NULL DEFAULT 0,
      native_characters INTEGER NOT NULL DEFAULT 0,
      ocr_characters INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(content_hash, extractor_version)
    );

    CREATE TABLE IF NOT EXISTS source_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      stable_id TEXT,
      relative_path TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT,
      source_id TEXT,
      source_path TEXT,
      mime_type TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      modified_time TEXT,
      content_hash TEXT,
      artifact_id TEXT REFERENCES artifacts(id),
      extractor_version TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      coverage_status TEXT,
      error TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS idx_source_files_project_active ON source_files(project_id, active);
    CREATE INDEX IF NOT EXISTS idx_source_files_stable ON source_files(project_id, stable_id);
    CREATE INDEX IF NOT EXISTS idx_source_files_hash ON source_files(content_hash);
    CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(content_hash, extractor_version);

    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      total_files INTEGER NOT NULL DEFAULT 0,
      new_files INTEGER NOT NULL DEFAULT 0,
      modified_files INTEGER NOT NULL DEFAULT 0,
      retry_files INTEGER NOT NULL DEFAULT 0,
      renamed_files INTEGER NOT NULL DEFAULT 0,
      unchanged_files INTEGER NOT NULL DEFAULT 0,
      deleted_files INTEGER NOT NULL DEFAULT 0,
      reused_artifacts INTEGER NOT NULL DEFAULT 0,
      processed_files INTEGER NOT NULL DEFAULT 0,
      partial_files INTEGER NOT NULL DEFAULT 0,
      failed_files INTEGER NOT NULL DEFAULT 0,
      bytes_scanned INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_run_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
      file_id INTEGER REFERENCES source_files(id) ON DELETE SET NULL,
      ordinal INTEGER NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      previous_relative_path TEXT,
      artifact_id TEXT REFERENCES artifacts(id),
      error TEXT,
      source_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_sync_run_files_run ON sync_run_files(run_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_project ON sync_runs(project_id, started_at DESC);

    -- Estas tabelas fazem parte do schema-base para que
    -- diagnósticos funcionem mesmo antes de os repositórios específicos
    -- serem importados/inicializados. As funções de init dedicadas seguem
    -- idempotentes e podem recriar os índices com segurança.
    CREATE TABLE IF NOT EXISTS project_datasets (
      snapshot_id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      area TEXT NOT NULL,
      obra TEXT NOT NULL,
      project_base TEXT NOT NULL DEFAULT 'GO',
      status TEXT NOT NULL,
      total_files INTEGER NOT NULL DEFAULT 0,
      artifact_files INTEGER NOT NULL DEFAULT 0,
      ocr_characters INTEGER NOT NULL DEFAULT 0,
      corpus_characters INTEGER NOT NULL DEFAULT 0,
      manifest_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_datasets_project ON project_datasets(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      preparation_id TEXT NOT NULL,
      area TEXT NOT NULL,
      obra TEXT NOT NULL,
      project_base TEXT NOT NULL DEFAULT 'GO',
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      analysis_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_snapshot ON chat_sessions(snapshot_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS sync_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area TEXT NOT NULL,
      obra TEXT NOT NULL,
      project_base TEXT NOT NULL DEFAULT 'GO',
      enabled INTEGER NOT NULL DEFAULT 0,
      times_json TEXT NOT NULL DEFAULT '[]',
      timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
      on_analysis_refresh INTEGER NOT NULL DEFAULT 1,
      last_run_key TEXT,
      last_job_id TEXT,
      last_started_at TEXT,
      last_completed_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(area,obra,project_base)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_schedules_enabled ON sync_schedules(enabled, area, obra, project_base);

    CREATE TABLE IF NOT EXISTS analysis_versions (
      id TEXT PRIMARY KEY,
      area TEXT NOT NULL, obra TEXT NOT NULL, project_base TEXT NOT NULL DEFAULT 'GO',
      version_no INTEGER NOT NULL, parent_version_id TEXT, chat_session_id TEXT,
      snapshot_id TEXT NOT NULL, preparation_id TEXT NOT NULL, analysis_id TEXT, status TEXT NOT NULL,
      periodicity TEXT, comparison_json TEXT NOT NULL DEFAULT '[]', delta_json TEXT, result_summary_json TEXT,
      created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
      UNIQUE(area,obra,project_base,version_no)
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_versions_project ON analysis_versions(area,obra,project_base,version_no DESC);
    CREATE INDEX IF NOT EXISTS idx_analysis_versions_analysis ON analysis_versions(analysis_id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, chat_session_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
      content TEXT NOT NULL, metadata_json TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(chat_session_id,created_at ASC);
  `);
  // Migrações aditivas seguras para instalações já existentes desta linha.
  try { db.exec(`ALTER TABLE artifacts ADD COLUMN public_json TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sync_runs ADD COLUMN retry_files INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE project_datasets ADD COLUMN project_base TEXT NOT NULL DEFAULT 'GO'`); } catch {}
  try { db.exec(`ALTER TABLE chat_sessions ADD COLUMN project_base TEXT NOT NULL DEFAULT 'GO'`); } catch {}
  db.prepare(`INSERT OR REPLACE INTO app_meta(key,value) VALUES('schema_version','4')`).run();
  return db;
}

function getDb() { return initDatabase(); }

export function dbDiagnostics() {
  const conn = getDb();
  const stats = conn.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM source_files WHERE active=1) AS active_files,
      (SELECT COUNT(*) FROM artifacts) AS artifacts,
      (SELECT COUNT(*) FROM sync_runs) AS sync_runs,
      (SELECT COUNT(*) FROM project_datasets) AS project_datasets,
      (SELECT COUNT(*) FROM chat_sessions) AS chat_sessions,
      (SELECT COUNT(*) FROM sync_schedules) AS sync_schedules
  `).get();
  let bytes = 0;
  try { bytes = fs.statSync(config.databasePath).size; } catch {}
  return { engine:'SQLite (node:sqlite)', path:config.databasePath, wal:true, bytes, ...stats };
}

export function ensureProject({ area, obra, folderPath, sourceMode }) {
  const conn = getDb();
  const ts = now();
  conn.prepare(`
    INSERT INTO projects(area,obra,folder_path,source_mode,created_at,updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(area,obra,source_mode) DO UPDATE SET folder_path=excluded.folder_path, updated_at=excluded.updated_at
  `).run(area, obra, folderPath || null, sourceMode, ts, ts);
  return conn.prepare(`SELECT * FROM projects WHERE area=? AND obra=? AND source_mode=?`).get(area, obra, sourceMode);
}

export function getActiveFiles(projectId) {
  return getDb().prepare(`SELECT * FROM source_files WHERE project_id=? AND active=1 ORDER BY relative_path`).all(projectId);
}

export function beginSyncRun({ id, projectId, totalFiles, bytesScanned }) {
  const conn = getDb();
  const ts = now();
  conn.prepare(`UPDATE sync_runs SET status='interrupted', completed_at=?, updated_at=? WHERE project_id=? AND status='processing'`).run(ts, ts, projectId);
  conn.prepare(`
    INSERT INTO sync_runs(id,project_id,status,started_at,total_files,bytes_scanned,created_at,updated_at)
    VALUES(?,?, 'processing', ?, ?, ?, ?, ?)
  `).run(id, projectId, ts, totalFiles || 0, bytesScanned || 0, ts, ts);
}

export function updateSyncRun(id, patch={}) {
  const allowed = ['status','completed_at','total_files','new_files','modified_files','retry_files','renamed_files','unchanged_files','deleted_files','reused_artifacts','processed_files','partial_files','failed_files','bytes_scanned','error'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sql = `UPDATE sync_runs SET ${keys.map(k=>`${k}=?`).join(', ')}, updated_at=? WHERE id=?`;
  getDb().prepare(sql).run(...keys.map(k => patch[k]), now(), id);
}

export function finishSyncRun(id, patch={}) {
  updateSyncRun(id, { ...patch, completed_at:patch.completed_at || now() });
}

export function createOrUpdateFile(projectId, file, { recordId=null, status='discovered', active=true, previousRelativePath=null }={}) {
  const conn = getDb();
  const ts = now();
  if (recordId) {
    // Um caminho antigo/inativo não pode impedir um rename real de ocupar o novo caminho.
    conn.prepare(`DELETE FROM source_files WHERE project_id=? AND relative_path=? AND id<>? AND active=0`).run(projectId, file.relativePath, recordId);
    conn.prepare(`
      UPDATE source_files SET stable_id=?, relative_path=?, name=?, ext=?, source_id=?, source_path=?, mime_type=?, size=?, modified_time=?, status=?, active=?, last_seen_at=?, updated_at=? WHERE id=?
    `).run(file.stableId || null, file.relativePath, file.name, file.ext || null, text(file.id), file.path || null, file.mimeType || null, Number(file.size || 0), file.modifiedTime || null, status, bool(active), ts, ts, recordId);
    return conn.prepare(`SELECT * FROM source_files WHERE id=?`).get(recordId);
  }
  conn.prepare(`
    INSERT INTO source_files(project_id,stable_id,relative_path,name,ext,source_id,source_path,mime_type,size,modified_time,status,active,first_seen_at,last_seen_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,relative_path) DO UPDATE SET
      stable_id=excluded.stable_id,name=excluded.name,ext=excluded.ext,source_id=excluded.source_id,source_path=excluded.source_path,mime_type=excluded.mime_type,size=excluded.size,modified_time=excluded.modified_time,status=excluded.status,active=excluded.active,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at
  `).run(projectId, file.stableId || null, file.relativePath, file.name, file.ext || null, text(file.id), file.path || null, file.mimeType || null, Number(file.size || 0), file.modifiedTime || null, status, bool(active), ts, ts, ts);
  return conn.prepare(`SELECT * FROM source_files WHERE project_id=? AND relative_path=?`).get(projectId, file.relativePath);
}

export function markFileDeleted(fileId) {
  const ts = now();
  getDb().prepare(`UPDATE source_files SET active=0,status='deleted',last_seen_at=?,updated_at=? WHERE id=?`).run(ts, ts, fileId);
}

export function touchFile(fileId, file) {
  const ts = now();
  getDb().prepare(`
    UPDATE source_files SET stable_id=?, name=?, ext=?, source_id=?, source_path=?, mime_type=?, size=?, modified_time=?, active=1,last_seen_at=?,updated_at=? WHERE id=?
  `).run(file.stableId || null, file.name, file.ext || null, text(file.id), file.path || null, file.mimeType || null, Number(file.size || 0), file.modifiedTime || null, ts, ts, fileId);
}

export function setFileArtifact(fileId, { artifactId, contentHash, extractorVersion, status, coverageStatus, error=null }) {
  const ts = now();
  getDb().prepare(`
    UPDATE source_files SET artifact_id=?,content_hash=?,extractor_version=?,status=?,coverage_status=?,error=?,active=1,last_seen_at=?,updated_at=? WHERE id=?
  `).run(artifactId || null, contentHash || null, extractorVersion || null, status || 'extracted', coverageStatus || null, error || null, ts, ts, fileId);
}

export function findArtifactByHash(contentHash, extractorVersion, compatibleExtractorVersions=[]) {
  if (!contentHash) return null;
  const versions = [...new Set([extractorVersion, ...compatibleExtractorVersions].filter(Boolean))];
  const placeholders = versions.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT id,content_hash,extractor_version,kind,coverage_status,public_json,json_bytes,compressed_bytes,corpus_characters,native_characters,ocr_characters,created_at,updated_at
    FROM artifacts
    WHERE content_hash=? AND extractor_version IN (${placeholders}) AND coverage_status='complete'
    ORDER BY CASE WHEN extractor_version=? THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).get(contentHash, ...versions, extractorVersion) || null;
}

export function saveArtifactRecord(artifact, { id=null, contentHash=null, extractorVersion=null, salt='' }={}) {
  const conn = getDb();
  const hash = contentHash || artifact.contentHash || null;
  const version = extractorVersion || artifact.extractorVersion || 'unknown';
  const artifactId = id || artifactIdFor(hash, version, salt || artifact.source?.relativePath || artifact.source?.name || '');
  const json = JSON.stringify(artifact);
  const compressed = gzipSync(Buffer.from(json, 'utf8'), { level:6 });
  const ts = now();
  conn.prepare(`
    INSERT INTO artifacts(id,content_hash,extractor_version,kind,coverage_status,public_json,json_gzip,json_bytes,compressed_bytes,corpus_characters,native_characters,ocr_characters,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,coverage_status=excluded.coverage_status,public_json=excluded.public_json,json_gzip=excluded.json_gzip,json_bytes=excluded.json_bytes,compressed_bytes=excluded.compressed_bytes,corpus_characters=excluded.corpus_characters,native_characters=excluded.native_characters,ocr_characters=excluded.ocr_characters,updated_at=excluded.updated_at
  `).run(
    artifactId, hash, version, artifact.kind || null, artifact.coverage?.status || artifact.analysisCorpus?.coverage?.status || null,
    JSON.stringify({
      schemaVersion:artifact.schemaVersion, kind:artifact.kind, extractedBy:artifact.extractedBy, metrics:artifact.metrics || {}, requiresVision:Boolean(artifact.requiresVision), machineReadable:true, contentHash:artifact.contentHash, sourcePreserved:Boolean(artifact.sourceBlobRef), preview:String(artifact.text || '').slice(0,5000),
      ocr:artifact.ocr ? { enabled:Boolean(artifact.ocr.enabled), eligible:artifact.ocr.eligible !== false, notApplicable:Boolean(artifact.ocr.notApplicable), applied:Boolean(artifact.ocr.applied), complete:artifact.ocr.complete !== false, pending:Boolean(artifact.ocr.pending), interrupted:Boolean(artifact.ocr.interrupted), targetCount:artifact.ocr.targetCount ?? null, completedTargets:artifact.ocr.completedTargets ?? null, failedTargets:artifact.ocr.failedTargets ?? null, characters:artifact.ocr.characters || 0, error:artifact.ocr.error || null } : null,
      technicalSummary:artifact.technicalSummary || null, coverage:artifact.coverage || artifact.analysisCorpus?.coverage || null, corpusStats:artifact.analysisCorpus?.stats || null
    }),
    compressed, Buffer.byteLength(json), compressed.length,
    Number(artifact.analysisCorpus?.stats?.combinedCharacters || 0), Number(artifact.analysisCorpus?.stats?.nativeCharacters || 0), Number(artifact.analysisCorpus?.stats?.ocrCharacters || 0),
    ts, ts
  );
  return artifactId;
}

export function loadArtifactRecord(artifactId) {
  if (!artifactId) throw new Error('artifactId ausente.');
  const row = getDb().prepare(`SELECT * FROM artifacts WHERE id=?`).get(artifactId);
  if (!row) throw new Error(`Artefato ${artifactId} não encontrado no banco.`);
  const bytes = Buffer.from(row.json_gzip);
  return JSON.parse(gunzipSync(bytes).toString('utf8'));
}

export function addRunFile({ runId, fileId, ordinal, action, status='queued', previousRelativePath=null, artifactId=null, error=null, source }) {
  const ts = now();
  getDb().prepare(`
    INSERT INTO sync_run_files(run_id,file_id,ordinal,action,status,previous_relative_path,artifact_id,error,source_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id,ordinal) DO UPDATE SET file_id=excluded.file_id,action=excluded.action,status=excluded.status,previous_relative_path=excluded.previous_relative_path,artifact_id=excluded.artifact_id,error=excluded.error,source_json=excluded.source_json,updated_at=excluded.updated_at
  `).run(runId, fileId || null, ordinal, action, status, previousRelativePath, artifactId, error, JSON.stringify(source), ts, ts);
}

export function updateRunFile(runId, ordinal, patch={}) {
  const allowed = ['file_id','action','status','previous_relative_path','artifact_id','error','source_json'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) return;
  getDb().prepare(`UPDATE sync_run_files SET ${keys.map(k=>`${k}=?`).join(', ')},updated_at=? WHERE run_id=? AND ordinal=?`).run(...keys.map(k=>patch[k]), now(), runId, ordinal);
}

export function getSyncRun(id) {
  return getDb().prepare(`SELECT * FROM sync_runs WHERE id=?`).get(id) || null;
}

export function getSyncRunFiles(id) {
  return getDb().prepare(`
    SELECT rf.*, sf.relative_path AS db_relative_path, sf.name AS db_name, sf.ext AS db_ext, sf.content_hash AS db_content_hash, sf.coverage_status AS db_coverage_status
    FROM sync_run_files rf LEFT JOIN source_files sf ON sf.id=rf.file_id
    WHERE rf.run_id=? ORDER BY rf.ordinal
  `).all(id);
}

export function latestSyncForProject(projectId) {
  return getDb().prepare(`SELECT * FROM sync_runs WHERE project_id=? ORDER BY started_at DESC LIMIT 1`).get(projectId) || null;
}

export function getProjectById(id) { return getDb().prepare(`SELECT * FROM projects WHERE id=?`).get(id) || null; }

export function cleanupOrphanArtifacts() {
  const conn = getDb();
  const result = conn.prepare(`DELETE FROM artifacts WHERE id NOT IN (SELECT artifact_id FROM source_files WHERE artifact_id IS NOT NULL) AND id NOT IN (SELECT artifact_id FROM sync_run_files WHERE artifact_id IS NOT NULL)`).run();
  return Number(result.changes || 0);
}

export function getArtifactSummary(artifactId) {
  if (!artifactId) return null;
  const row = getDb().prepare(`SELECT id,content_hash,extractor_version,kind,coverage_status,public_json,json_bytes,compressed_bytes,corpus_characters,native_characters,ocr_characters,created_at,updated_at FROM artifacts WHERE id=?`).get(artifactId);
  if (!row) return null;
  return { ...row, public:row.public_json ? JSON.parse(row.public_json) : null };
}

export function getProjectFiles(projectId, { activeOnly=true }={}) {
  return getDb().prepare(`SELECT * FROM source_files WHERE project_id=? ${activeOnly ? 'AND active=1' : ''} ORDER BY relative_path`).all(projectId);
}

export function findProject(area, obra, sourceMode) {
  return getDb().prepare(`SELECT * FROM projects WHERE area=? AND obra=? AND source_mode=?`).get(area, obra, sourceMode) || null;
}
