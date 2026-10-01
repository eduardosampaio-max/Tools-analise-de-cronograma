import crypto from 'node:crypto';
import { initDatabase } from './database.js';

function db(){ return initDatabase(); }
function now(){ return new Date().toISOString(); }
function j(v,fallback=null){ try{return JSON.parse(v||'');}catch{return fallback;} }

export function initAnalysisVersionSchema(){
  db().exec(`
    CREATE TABLE IF NOT EXISTS analysis_versions (
      id TEXT PRIMARY KEY,
      area TEXT NOT NULL,
      obra TEXT NOT NULL,
      project_base TEXT NOT NULL DEFAULT 'GO',
      version_no INTEGER NOT NULL,
      parent_version_id TEXT,
      chat_session_id TEXT,
      snapshot_id TEXT NOT NULL,
      preparation_id TEXT NOT NULL,
      analysis_id TEXT,
      status TEXT NOT NULL,
      periodicity TEXT,
      comparison_json TEXT NOT NULL DEFAULT '[]',
      delta_json TEXT,
      result_summary_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(area,obra,project_base,version_no)
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_versions_project ON analysis_versions(area,obra,project_base,version_no DESC);
    CREATE INDEX IF NOT EXISTS idx_analysis_versions_analysis ON analysis_versions(analysis_id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(chat_session_id,created_at ASC);
  `);
}

function map(row){
  if(!row) return null;
  return {
    id:row.id,area:row.area,obra:row.obra,projectBase:row.project_base||'GO',versionNo:Number(row.version_no),
    parentVersionId:row.parent_version_id||null,chatSessionId:row.chat_session_id||null,snapshotId:row.snapshot_id,preparationId:row.preparation_id,
    analysisId:row.analysis_id||null,status:row.status,periodicity:row.periodicity||null,comparison:j(row.comparison_json,[]),delta:j(row.delta_json,null),
    resultSummary:j(row.result_summary_json,null),createdAt:row.created_at,completedAt:row.completed_at||null,updatedAt:row.updated_at,
  };
}


function backfillLegacyVersions(area,obra,projectBase='GO'){
  initAnalysisVersionSchema();
  const rows=db().prepare(`SELECT * FROM chat_sessions WHERE area=? AND obra=? AND project_base=? AND analysis_id IS NOT NULL AND status='completed' ORDER BY created_at ASC`).all(area,obra,projectBase);
  let previous=db().prepare(`SELECT id,version_no FROM analysis_versions WHERE area=? AND obra=? AND project_base=? ORDER BY version_no DESC LIMIT 1`).get(area,obra,projectBase)||null;
  for(const row of rows){
    if(db().prepare(`SELECT 1 FROM analysis_versions WHERE analysis_id=?`).get(row.analysis_id)) continue;
    const state=j(row.state_json,{})||{}, answers=state.answers||{}, detected=state.qualification?.detected||{};
    const comparison=Array.isArray(answers.comparisonPeriods)&&answers.comparisonPeriods.length?answers.comparisonPeriods:(detected.versions||[]).map(v=>v.path||v.name).filter(Boolean);
    const versionNo=Number(previous?.version_no||0)+1, id=`av_${crypto.randomUUID()}`, ts=row.updated_at||row.created_at||now();
    db().prepare(`INSERT INTO analysis_versions(id,area,obra,project_base,version_no,parent_version_id,chat_session_id,snapshot_id,preparation_id,analysis_id,status,periodicity,comparison_json,created_at,completed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?,?)`)
      .run(id,area,obra,projectBase,versionNo,previous?.id||null,row.id,row.snapshot_id,row.preparation_id,row.analysis_id,answers.periodicity||null,JSON.stringify(comparison),row.created_at||ts,ts,ts);
    previous={id,version_no:versionNo};
  }
}

export function listAnalysisVersions(area,obra,projectBase='GO'){
  initAnalysisVersionSchema(); backfillLegacyVersions(area,obra,projectBase);
  return db().prepare(`SELECT * FROM analysis_versions WHERE area=? AND obra=? AND project_base=? ORDER BY version_no DESC`).all(area,obra,projectBase).map(map);
}
export function latestAnalysisVersion(area,obra,projectBase='GO'){
  initAnalysisVersionSchema(); backfillLegacyVersions(area,obra,projectBase);
  return map(db().prepare(`SELECT * FROM analysis_versions WHERE area=? AND obra=? AND project_base=? AND status='completed' ORDER BY version_no DESC LIMIT 1`).get(area,obra,projectBase));
}
export function getAnalysisVersion(id){ initAnalysisVersionSchema(); return map(db().prepare(`SELECT * FROM analysis_versions WHERE id=?`).get(id)); }
export function getAnalysisVersionByAnalysisId(analysisId){ initAnalysisVersionSchema(); return map(db().prepare(`SELECT * FROM analysis_versions WHERE analysis_id=?`).get(analysisId)); }

export function createAnalysisVersion({area,obra,projectBase='GO',parentVersionId=null,chatSessionId=null,snapshotId,preparationId,periodicity=null,comparison=[]}){
  initAnalysisVersionSchema(); const ts=now();
  const row=db().prepare(`SELECT COALESCE(MAX(version_no),0)+1 AS n FROM analysis_versions WHERE area=? AND obra=? AND project_base=?`).get(area,obra,projectBase);
  const id=`av_${crypto.randomUUID()}`; const versionNo=Number(row?.n||1);
  db().prepare(`INSERT INTO analysis_versions(id,area,obra,project_base,version_no,parent_version_id,chat_session_id,snapshot_id,preparation_id,status,periodicity,comparison_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)`)
    .run(id,area,obra,projectBase,versionNo,parentVersionId,chatSessionId,snapshotId,preparationId,periodicity,JSON.stringify(comparison||[]),ts,ts);
  return getAnalysisVersion(id);
}

export function updateAnalysisVersion(id,patch={}){
  initAnalysisVersionSchema(); const current=getAnalysisVersion(id); if(!current) return null;
  const fields=[]; const vals=[];
  const put=(col,val)=>{fields.push(`${col}=?`);vals.push(val);};
  if(patch.analysisId!==undefined) put('analysis_id',patch.analysisId||null);
  if(patch.status!==undefined) put('status',patch.status);
  if(patch.snapshotId!==undefined) put('snapshot_id',patch.snapshotId);
  if(patch.preparationId!==undefined) put('preparation_id',patch.preparationId);
  if(patch.periodicity!==undefined) put('periodicity',patch.periodicity||null);
  if(patch.comparison!==undefined) put('comparison_json',JSON.stringify(patch.comparison||[]));
  if(patch.delta!==undefined) put('delta_json',JSON.stringify(patch.delta||null));
  if(patch.resultSummary!==undefined) put('result_summary_json',JSON.stringify(patch.resultSummary||null));
  if(patch.completedAt!==undefined) put('completed_at',patch.completedAt||null);
  put('updated_at',now()); vals.push(id);
  db().prepare(`UPDATE analysis_versions SET ${fields.join(',')} WHERE id=?`).run(...vals);
  return getAnalysisVersion(id);
}

export function addChatMessage(chatSessionId,{role,kind='message',content,metadata=null}){
  initAnalysisVersionSchema(); const id=`msg_${crypto.randomUUID()}`;
  db().prepare(`INSERT INTO chat_messages(id,chat_session_id,role,kind,content,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)`).run(id,chatSessionId,role,kind,String(content||''),metadata?JSON.stringify(metadata):null,now());
  return {id,chatSessionId,role,kind,content:String(content||''),metadata,createdAt:now()};
}
export function listChatMessages(chatSessionId){
  initAnalysisVersionSchema();
  return db().prepare(`SELECT * FROM chat_messages WHERE chat_session_id=? ORDER BY created_at ASC`).all(chatSessionId).map(r=>({id:r.id,chatSessionId:r.chat_session_id,role:r.role,kind:r.kind,content:r.content,metadata:j(r.metadata_json,null),createdAt:r.created_at}));
}
