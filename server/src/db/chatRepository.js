import crypto from 'node:crypto';
import { initDatabase } from './database.js';

function db(){ return initDatabase(); }
function now(){ return new Date().toISOString(); }

export function initChatSchema(){
  db().exec(`
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
  `);
  try { db().exec(`ALTER TABLE chat_sessions ADD COLUMN project_base TEXT NOT NULL DEFAULT 'GO'`); } catch {}
}

export function createChatSession({snapshotId,preparationId,area,obra,projectBase='GO',state}){
  initChatSchema();
  const id=`chat_${crypto.randomUUID()}`;
  const ts=now();
  db().prepare(`INSERT INTO chat_sessions(id,snapshot_id,preparation_id,area,obra,project_base,status,state_json,analysis_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,snapshotId,preparationId,area,obra,projectBase,state?.status || 'qualification',JSON.stringify(state||{}),null,ts,ts);
  return getChatSession(id);
}

export function getChatSession(id){
  initChatSchema();
  const row=db().prepare(`SELECT * FROM chat_sessions WHERE id=?`).get(id);
  if(!row) return null;
  return {
    id:row.id,snapshotId:row.snapshot_id,preparationId:row.preparation_id,area:row.area,obra:row.obra,projectBase:row.project_base || 'GO',
    status:row.status,analysisId:row.analysis_id || null,createdAt:row.created_at,updatedAt:row.updated_at,
    state:JSON.parse(row.state_json || '{}'),
  };
}

export function updateChatSession(id,{status,state,analysisId,snapshotId,preparationId}={}){
  initChatSchema();
  const current=getChatSession(id);
  if(!current) throw new Error('Sessão de chat não encontrada.');
  const nextState=state ?? current.state;
  const nextStatus=status ?? current.status;
  const nextAnalysis=analysisId === undefined ? current.analysisId : analysisId;
  const nextSnapshot=snapshotId ?? current.snapshotId;
  const nextPreparation=preparationId ?? current.preparationId;
  db().prepare(`UPDATE chat_sessions SET snapshot_id=?,preparation_id=?,status=?,state_json=?,analysis_id=?,updated_at=? WHERE id=?`)
    .run(nextSnapshot,nextPreparation,nextStatus,JSON.stringify(nextState||{}),nextAnalysis||null,now(),id);
  return getChatSession(id);
}

export function latestChatSessionForSnapshot(snapshotId){
  initChatSchema();
  const row=db().prepare(`SELECT id FROM chat_sessions WHERE snapshot_id=? ORDER BY created_at DESC LIMIT 1`).get(snapshotId);
  return row ? getChatSession(row.id) : null;
}

export function latestChatSessionForProject(area,obra,projectBase='GO'){
  initChatSchema();
  const row=db().prepare(`SELECT id FROM chat_sessions WHERE area=? AND obra=? AND project_base=? ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get(area,obra,projectBase);
  return row ? getChatSession(row.id) : null;
}
