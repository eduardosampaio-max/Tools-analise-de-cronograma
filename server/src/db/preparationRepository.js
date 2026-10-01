import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { initDatabase } from './database.js';

function now() { return new Date().toISOString(); }
function db() { return initDatabase(); }

export function initPreparationSchema() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS ai_preparations (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL,
      master_characters INTEGER NOT NULL DEFAULT 0,
      prepared_characters INTEGER NOT NULL DEFAULT 0,
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      reduction_pct REAL NOT NULL DEFAULT 0,
      project_documents INTEGER NOT NULL DEFAULT 0,
      auxiliary_documents INTEGER NOT NULL DEFAULT 0,
      selected_schedule_documents INTEGER NOT NULL DEFAULT 0,
      json_gzip BLOB NOT NULL,
      json_bytes INTEGER NOT NULL DEFAULT 0,
      compressed_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_preparations_snapshot ON ai_preparations(snapshot_id, created_at DESC);
  `);
}

export function savePreparation(preparation) {
  initPreparationSchema();
  const serialized = JSON.stringify(preparation);
  const zipped = gzipSync(Buffer.from(serialized,'utf8'), { level:6 });
  const ts = now();
  db().prepare(`
    INSERT INTO ai_preparations(
      id,snapshot_id,status,master_characters,prepared_characters,estimated_tokens,reduction_pct,
      project_documents,auxiliary_documents,selected_schedule_documents,json_gzip,json_bytes,compressed_bytes,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,master_characters=excluded.master_characters,prepared_characters=excluded.prepared_characters,
      estimated_tokens=excluded.estimated_tokens,reduction_pct=excluded.reduction_pct,project_documents=excluded.project_documents,
      auxiliary_documents=excluded.auxiliary_documents,selected_schedule_documents=excluded.selected_schedule_documents,
      json_gzip=excluded.json_gzip,json_bytes=excluded.json_bytes,compressed_bytes=excluded.compressed_bytes,updated_at=excluded.updated_at
  `).run(
    preparation.id, preparation.snapshotId, preparation.status || 'ready',
    Number(preparation.stats?.masterCharacters || 0), Number(preparation.stats?.preparedCharacters || 0),
    Number(preparation.stats?.estimatedTokens || 0), Number(preparation.stats?.reductionPct || 0),
    Number(preparation.stats?.projectDocuments || 0), Number(preparation.stats?.auxiliaryDocuments || 0),
    Number(preparation.schedule?.selectedVersions?.length || 0), zipped, Buffer.byteLength(serialized), zipped.length, ts, ts
  );
  return preparation;
}

export function loadPreparation(id) {
  initPreparationSchema();
  const row = db().prepare(`SELECT * FROM ai_preparations WHERE id=?`).get(id);
  if (!row) throw new Error(`Preparação ${id} não encontrada.`);
  return JSON.parse(gunzipSync(Buffer.from(row.json_gzip)).toString('utf8'));
}

export function latestPreparationForSnapshot(snapshotId) {
  initPreparationSchema();
  const row = db().prepare(`SELECT id FROM ai_preparations WHERE snapshot_id=? ORDER BY created_at DESC LIMIT 1`).get(snapshotId);
  return row ? loadPreparation(row.id) : null;
}

export function createPreparationId(snapshotId) {
  return `prep_${crypto.createHash('sha1').update(`${snapshotId}|${Date.now()}|${Math.random()}`).digest('hex').slice(0,16)}`;
}
