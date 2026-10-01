import { initDatabase } from './database.js';
import { normalizeProjectBase } from '../domain/projectBase.js';

function db(){ return initDatabase(); }
function now(){ return new Date().toISOString(); }
function normalizeTime(value){
  const text=String(value||'').trim();
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error(`Horário inválido: ${value}. Use HH:MM.`);
  return text;
}
function normalizeTimes(values=[]){
  const raw=Array.isArray(values)?values:String(values||'').split(',');
  return [...new Set(raw.map(normalizeTime))].sort();
}
function rowToSchedule(row){
  if(!row) return null;
  let times=[];
  try{times=JSON.parse(row.times_json||'[]');}catch{}
  return {
    id:row.id,area:row.area,obra:row.obra,projectBase:row.project_base||'GO',enabled:Boolean(row.enabled),
    times,timezone:row.timezone||'America/Sao_Paulo',onAnalysisRefresh:Boolean(row.on_analysis_refresh),
    lastRunKey:row.last_run_key||null,lastJobId:row.last_job_id||null,lastStartedAt:row.last_started_at||null,
    lastCompletedAt:row.last_completed_at||null,lastStatus:row.last_status||null,lastError:row.last_error||null,
    createdAt:row.created_at,updatedAt:row.updated_at,
  };
}

export function initSyncScheduleSchema(){
  db().exec(`
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
  `);
}

export function getSyncSchedule(area,obra,projectBase='GO'){
  initSyncScheduleSchema();
  const base=normalizeProjectBase(projectBase);
  const row=db().prepare(`SELECT * FROM sync_schedules WHERE area=? AND obra=? AND project_base=?`).get(String(area).toUpperCase(),String(obra),base);
  return rowToSchedule(row);
}

export function listEnabledSyncSchedules(){
  initSyncScheduleSchema();
  return db().prepare(`SELECT * FROM sync_schedules WHERE enabled=1 ORDER BY area,obra,project_base`).all().map(rowToSchedule);
}

export function upsertSyncSchedule({area,obra,projectBase='GO',enabled=false,times=[],timezone='America/Sao_Paulo',onAnalysisRefresh=true}){
  initSyncScheduleSchema();
  const base=normalizeProjectBase(projectBase);
  const normalizedTimes=normalizeTimes(times);
  if(enabled && !normalizedTimes.length) throw new Error('Informe pelo menos um horário para ativar a atualização automática.');
  const ts=now();
  db().prepare(`
    INSERT INTO sync_schedules(area,obra,project_base,enabled,times_json,timezone,on_analysis_refresh,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(area,obra,project_base) DO UPDATE SET
      enabled=excluded.enabled,times_json=excluded.times_json,timezone=excluded.timezone,
      on_analysis_refresh=excluded.on_analysis_refresh,updated_at=excluded.updated_at
  `).run(String(area).toUpperCase(),String(obra),base,enabled?1:0,JSON.stringify(normalizedTimes),String(timezone||'America/Sao_Paulo'),onAnalysisRefresh?1:0,ts,ts);
  return getSyncSchedule(area,obra,base);
}

export function markScheduleRunStarted({area,obra,projectBase='GO',runKey,jobId}){
  initSyncScheduleSchema();
  const base=normalizeProjectBase(projectBase); const ts=now();
  db().prepare(`UPDATE sync_schedules SET last_run_key=?,last_job_id=?,last_started_at=?,last_status='processing',last_error=NULL,updated_at=? WHERE area=? AND obra=? AND project_base=?`)
    .run(runKey||null,jobId||null,ts,ts,String(area).toUpperCase(),String(obra),base);
  return getSyncSchedule(area,obra,base);
}

export function markScheduleRunFinished({area,obra,projectBase='GO',jobId,status,error=null}){
  initSyncScheduleSchema();
  const base=normalizeProjectBase(projectBase); const ts=now();
  db().prepare(`UPDATE sync_schedules SET last_job_id=?,last_completed_at=?,last_status=?,last_error=?,updated_at=? WHERE area=? AND obra=? AND project_base=?`)
    .run(jobId||null,ts,status||null,error||null,ts,String(area).toUpperCase(),String(obra),base);
  return getSyncSchedule(area,obra,base);
}

export function syncScheduleDiagnostics(){
  initSyncScheduleSchema();
  const row=db().prepare(`SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM sync_schedules`).get();
  return {total:Number(row?.total||0),enabled:Number(row?.enabled||0)};
}
