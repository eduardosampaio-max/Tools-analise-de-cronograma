import { initDatabase } from './database.js';

function db(){return initDatabase();}
function now(){return new Date().toISOString();}

export function initProjectDatasetSchema(){
  db().exec(`
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
  `);
  try { db().exec(`ALTER TABLE project_datasets ADD COLUMN project_base TEXT NOT NULL DEFAULT 'GO'`); } catch {}
}

export function saveProjectDataset({snapshot,projectId}){
  initProjectDatasetSchema();
  const ts=now();
  const files=(snapshot.files||[]).map((f,index)=>({
    index,name:f.name,relativePath:f.relativePath,ext:f.ext,size:f.size,modifiedTime:f.modifiedTime,
    status:f.status,artifactId:f.artifactId||f.artifactKey||null,contentHash:f.extraction?.contentHash||null,
    coverage:f.extraction?.coverage?.status||null,
    ocr:{applied:Boolean(f.extraction?.technicalSummary?.ocr?.applied),characters:Number(f.extraction?.technicalSummary?.ocr?.characters||0)},
  }));
  const manifest={
    schemaVersion:'tools.project.dataset.v2',
    description:'Manifesto persistido da base lógica do projeto (GO ou GP). Os payloads integrais permanecem normalizados na tabela artifacts e são materializados por streaming no endpoint de corpus JSON.',
    projectBase:snapshot.projectBase || snapshot.folder?.projectBase || 'GO',
    snapshot:{id:snapshot.id,area:snapshot.area,obra:snapshot.obra,folder:snapshot.folder,status:snapshot.status,totals:snapshot.totals},
    files,
    logicalProjectJson:{endpoint:`/api/snapshots/${snapshot.id}/corpus?format=json`,includes:['nativeText','ocrText','combinedText','machine','ocr','coverage','technicalSummary','analysisCorpus']},
  };
  db().prepare(`
    INSERT INTO project_datasets(snapshot_id,project_id,area,obra,project_base,status,total_files,artifact_files,ocr_characters,corpus_characters,manifest_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(snapshot_id) DO UPDATE SET project_base=excluded.project_base,status=excluded.status,total_files=excluded.total_files,artifact_files=excluded.artifact_files,
      ocr_characters=excluded.ocr_characters,corpus_characters=excluded.corpus_characters,manifest_json=excluded.manifest_json,updated_at=excluded.updated_at
  `).run(snapshot.id,projectId,snapshot.area,snapshot.obra,snapshot.projectBase || snapshot.folder?.projectBase || 'GO',snapshot.status,Number(snapshot.totals?.files||0),Number(snapshot.totals?.artifacts||0),Number(snapshot.totals?.ocrCharacters||0),Number(snapshot.totals?.corpusCharacters||0),JSON.stringify(manifest),ts,ts);
  return getProjectDataset(snapshot.id);
}

export function getProjectDataset(snapshotId){
  initProjectDatasetSchema();
  const row=db().prepare(`SELECT * FROM project_datasets WHERE snapshot_id=?`).get(snapshotId);
  if(!row)return null;
  return {snapshotId:row.snapshot_id,projectId:row.project_id,area:row.area,obra:row.obra,projectBase:row.project_base || 'GO',status:row.status,totalFiles:row.total_files,artifactFiles:row.artifact_files,ocrCharacters:row.ocr_characters,corpusCharacters:row.corpus_characters,createdAt:row.created_at,updatedAt:row.updated_at,manifest:JSON.parse(row.manifest_json||'{}')};
}

export function latestProjectDataset(projectId){
  initProjectDatasetSchema();
  const row=db().prepare(`SELECT snapshot_id FROM project_datasets WHERE project_id=? ORDER BY updated_at DESC LIMIT 1`).get(projectId);
  return row?getProjectDataset(row.snapshot_id):null;
}
