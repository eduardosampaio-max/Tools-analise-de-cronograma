import { loadSnapshotFromDatabase, loadArtifactFromDatabase } from '../db/snapshotRepository.js';
import { createPreparationId, savePreparation } from '../db/preparationRepository.js';
import { config } from '../config.js';
import crypto from 'node:crypto';
import { loadPackageInstructions, packageProfile } from '../package/cronogramaPackage.js';

const DROP_KEYS = new Set([
  'rawMspdiXml','rawProject','officeXmlParts','archiveEntries','xmlParts','rawXml','parsed','cells','vectorTextParts'
]);
const TASK_KEYS = [
  'UID','ID','Name','WBS','OutlineNumber','OutlineLevel','Start','Finish','Duration','PercentComplete','PercentWorkComplete',
  'PhysicalPercentComplete','ActualStart','ActualFinish','RemainingDuration','ConstraintType','ConstraintDate','Deadline','Critical',
  'Milestone','Summary','TotalSlack','FreeSlack','CalendarUID','Notes','Baselines','Predecessors','CustomFields','Active'
];

function arr(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
function str(v='') { return String(v ?? ''); }
function pick(obj, keys) { const out={}; for (const k of keys) if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== '') out[k]=obj[k]; return out; }
function n(v) { const x=Number(v); return Number.isFinite(x) ? x : null; }
function bool(v) { return v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function dateValue(v) { if (!v) return null; const d=new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
function isoDate(v) { const d=dateValue(v); return d ? d.toISOString() : null; }
function days(a,b) { const da=dateValue(a), db=dateValue(b); if (!da || !db) return null; return Math.round((db-da)/86400000); }
function tokenEstimate(chars) { return Math.ceil(Number(chars||0) / Math.max(2.2, Number(config.aiCharsPerTokenEstimate || 3.2))); }
function stableText(v='') { return str(v).replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim(); }
function normalizeKey(v='') { return stableText(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }

function uniqueLines(nativeText, ocrText) {
  const seen=new Set(); const out=[];
  for (const block of [nativeText,ocrText]) {
    for (const line of stableText(block).split('\n')) {
      const key=normalizeKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key); out.push(line.trim());
    }
  }
  return out.join('\n');
}

function scrub(value, depth=0) {
  if (depth > 8) return '[depth omitted]';
  if (Array.isArray(value)) return value.map(x=>scrub(x,depth+1));
  if (!value || typeof value !== 'object') return value;
  const out={};
  for (const [k,v] of Object.entries(value)) {
    if (DROP_KEYS.has(k)) continue;
    out[k]=scrub(v,depth+1);
  }
  return out;
}

function compactProject(file, artifact) {
  const p=artifact.machine?.project || {};
  const tasks=arr(p.tasks).map(t=>pick(t,TASK_KEYS));
  const assignments=arr(p.assignments).map(a=>pick(a,['UID','TaskUID','ResourceUID','Start','Finish','Work','ActualWork','RemainingWork','Cost','ActualCost','Units']));
  const resources=arr(p.resources).map(r=>pick(r,['UID','ID','Name','Type','Initials','Group','MaxUnits','StandardRate','OvertimeRate','Cost','ActualCost','Work','ActualWork','RemainingWork']));
  const calendars=arr(p.calendars).map(c=>pick(c,['UID','Name','IsBaseCalendar','BaseCalendarUID','WeekDays','Exceptions']));
  return {
    role:'schedule_native',
    source:{ name:file.name, relativePath:file.relativePath, modifiedTime:file.modifiedTime, ext:file.ext },
    projectInfo:p.projectInfo || {}, tasks, resources, assignments, calendars,
    extendedAttributeDefinitions:p.extendedAttributeDefinitions || [], outlineCodes:p.outlineCodes || [], wbsMasks:p.wbsMasks || null,
    coverage:artifact.coverage || null,
  };
}

function rowRelevant(row, keywords) {
  const hay=normalizeKey(arr(row).map(x=>str(x)).join(' '));
  return keywords.some(k=>hay.includes(normalizeKey(k)));
}

function compactSpreadsheet(file, artifact, keywords=[]) {
  const wb=artifact.machine?.workbook || {};
  const sheets=arr(wb.sheets).map(s=>{
    const rows=arr(s.rows);
    const sample=[]; const used=new Set();
    const add=(row,i,reason)=>{ if (used.has(i) || sample.length>=35) return; used.add(i); sample.push({row:i+1,reason,values:row}); };
    rows.slice(0,8).forEach((r,i)=>add(r,i,'inicio'));
    rows.forEach((r,i)=>{ if (sample.length<30 && rowRelevant(r,keywords)) add(r,i,'relevante'); });
    rows.slice(-5).forEach((r,j)=>add(r,Math.max(0,rows.length-5+j),'fim'));
    return { name:s.name,range:s.range,rowCount:s.rowCount,sampleRows:sample,formulas:arr(s.formulas).slice(0,80),merges:arr(s.merges).slice(0,80),autoFilter:s.autoFilter||null };
  });
  const text=uniqueLines(artifact.nativeText || artifact.text || '', artifact.ocrText || '');
  return {
    role:'spreadsheet', source:{ name:file.name, relativePath:file.relativePath, modifiedTime:file.modifiedTime, ext:file.ext },
    sheetNames:wb.sheetNames || [], sheets, definedNames:wb.definedNames || [], hasVba:Boolean(wb.hasVba),
    text:relevantSnippets(text,keywords,18000), summary:artifact.technicalSummary || null,
    coverage:artifact.coverage || null,
  };
}

function compactPdfOrText(file, artifact, keywords=[]) {
  const full=uniqueLines(artifact.nativeText || artifact.text || '', artifact.ocrText || '');
  return {
    role:artifact.kind,
    source:{ name:file.name, relativePath:file.relativePath, modifiedTime:file.modifiedTime, ext:file.ext },
    text:relevantSnippets(full,keywords,18000),
    metadata:scrub(artifact.kind === 'pdf' ? { info:artifact.machine?.pdf?.info, metadata:artifact.machine?.pdf?.metadata, pages:artifact.machine?.pdf?.pages } : {}),
    summary:artifact.technicalSummary || null,
    coverage:artifact.coverage || null,
  };
}

function compactGeneric(file, artifact, keywords=[]) {
  const full=uniqueLines(artifact.nativeText || artifact.text || '', artifact.ocrText || '');
  return {
    role:artifact.kind || 'document', source:{ name:file.name, relativePath:file.relativePath, modifiedTime:file.modifiedTime, ext:file.ext },
    text:relevantSnippets(full,keywords,14000), summary:artifact.technicalSummary || null, metrics:artifact.metrics || {}, coverage:artifact.coverage || null,
  };
}

function compactArtifact(file, artifact, keywords=[]) {
  if (artifact.kind === 'project') return compactProject(file,artifact);
  if (artifact.kind === 'spreadsheet') return compactSpreadsheet(file,artifact,keywords);
  if (['pdf','text','image'].includes(artifact.kind)) return compactPdfOrText(file,artifact,keywords);
  return compactGeneric(file,artifact,keywords);
}

function baselineFinish(task) {
  const b=arr(task.Baselines)[0] || {};
  return b.Finish || b.BaselineFinish || null;
}
function baselineStart(task) {
  const b=arr(task.Baselines)[0] || {};
  return b.Start || b.BaselineStart || null;
}
function pct(task) { return n(task.PercentComplete) ?? n(task.PhysicalPercentComplete) ?? n(task.PercentWorkComplete) ?? 0; }
function slackNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const m=String(v).match(/-?\d+(?:[.,]\d+)?/); return m ? Number(m[0].replace(',','.')) : null;
}
function taskKey(task) { return str(task.UID || task.ID || `${normalizeKey(task.WBS)}|${normalizeKey(task.Name)}`); }

function projectMetrics(doc) {
  const info=doc.projectInfo || {};
  const statusDate=info.StatusDate || info.CurrentDate || null;
  const tasks=doc.tasks || [];
  const incomplete=tasks.filter(t=>!bool(t.Summary) && pct(t)<100 && !t.ActualFinish);
  const overdue=incomplete.filter(t=>dateValue(t.Finish) && dateValue(statusDate) && dateValue(t.Finish)<dateValue(statusDate));
  const critical=incomplete.filter(t=>bool(t.Critical) || (slackNumber(t.TotalSlack) != null && slackNumber(t.TotalSlack)<=0));
  const milestones=tasks.filter(t=>bool(t.Milestone) || (str(t.Duration).startsWith('PT0') && !bool(t.Summary)));
  const gate=[...critical].sort((a,b)=>(dateValue(a.Finish)?.getTime()||Infinity)-(dateValue(b.Finish)?.getTime()||Infinity))[0] || null;
  const baselineFinishes=tasks.map(baselineFinish).filter(Boolean).sort();
  return {
    statusDate, start:info.StartDate || null, finish:info.FinishDate || null,
    baselineFinish:baselineFinishes.length ? baselineFinishes[baselineFinishes.length-1] : null,
    totalTasks:tasks.length, incompleteTasks:incomplete.length, overdueCount:overdue.length, criticalCount:critical.length, milestoneCount:milestones.length,
    overdue:overdue.map(t=>({ uid:t.UID,id:t.ID,wbs:t.WBS,name:t.Name,start:t.Start,finish:t.Finish,pct:pct(t),critical:bool(t.Critical),slack:t.TotalSlack,baselineFinish:baselineFinish(t) })),
    criticalPath:critical.map(t=>({ uid:t.UID,id:t.ID,wbs:t.WBS,name:t.Name,start:t.Start,finish:t.Finish,pct:pct(t),slack:t.TotalSlack,predecessors:t.Predecessors || [] })),
    milestones:milestones.map(t=>({ uid:t.UID,id:t.ID,wbs:t.WBS,name:t.Name,start:t.Start,finish:t.Finish,pct:pct(t),critical:bool(t.Critical),slack:t.TotalSlack,baselineFinish:baselineFinish(t) })),
    nextGate:gate ? { uid:gate.UID,id:gate.ID,wbs:gate.WBS,name:gate.Name,start:gate.Start,finish:gate.Finish,pct:pct(gate),slack:gate.TotalSlack } : null,
  };
}

function compareProjects(previous,current) {
  const prev=new Map((previous.tasks||[]).map(t=>[taskKey(t),t]));
  const changes=[];
  for (const t of current.tasks||[]) {
    const old=prev.get(taskKey(t)); if (!old) continue;
    const dFinish=days(old.Finish,t.Finish); const dStart=days(old.Start,t.Start);
    const pctDelta=(pct(t)-pct(old));
    if ((dFinish||0)!==0 || (dStart||0)!==0 || pctDelta!==0) changes.push({
      uid:t.UID,id:t.ID,wbs:t.WBS,name:t.Name,critical:bool(t.Critical),
      previous:{start:old.Start,finish:old.Finish,pct:pct(old)}, current:{start:t.Start,finish:t.Finish,pct:pct(t)},
      deltaStartDays:dStart,deltaFinishDays:dFinish,deltaPctPoints:pctDelta,
    });
  }
  changes.sort((a,b)=>Math.abs(b.deltaFinishDays||0)-Math.abs(a.deltaFinishDays||0));
  return changes;
}

function versionTime(doc) {
  const info=doc.projectInfo || {};
  return dateValue(info.StatusDate || info.LastSaved || doc.source?.modifiedTime)?.getTime() || 0;
}

function keywordsFromPrompt(prompt='') {
  const stop=new Set(['para','com','sem','uma','das','dos','que','como','mais','pela','pelo','entre','onde','isso','esta','este','deve','depois','arquivo','cronograma','analise','análise']);
  const words=normalizeKey(prompt).split(/\s+/).filter(w=>w.length>=4 && !stop.has(w));
  return [...new Set([...words,'baseline','linha de base','critico','crítico','marco','atraso','entrega','status','prazo','contrato','cliente','terceiro','liberacao','liberação','reprogramacao','reprogramação'])].slice(0,80);
}

function relevantSnippets(text, keywords, budget=7000) {
  const src=stableText(text); if (!src) return '';
  if (src.length<=budget) return src;
  const windows=[];
  windows.push(src.slice(0,Math.min(1800,budget)));
  const low=src.toLowerCase();
  for (const kw of keywords) {
    const q=kw.toLowerCase(); let pos=0; let hits=0;
    while ((pos=low.indexOf(q,pos))>=0 && hits<2) {
      const a=Math.max(0,pos-700), b=Math.min(src.length,pos+q.length+1300);
      windows.push(src.slice(a,b)); pos=b; hits++;
    }
  }
  if (src.length>4000) windows.push(src.slice(Math.floor(src.length/2)-700,Math.floor(src.length/2)+900));
  windows.push(src.slice(-1400));
  const out=[]; const seen=new Set(); let used=0;
  for (const w of windows) {
    const key=normalizeKey(w).slice(0,300); if (!key || seen.has(key)) continue;
    seen.add(key); const remaining=budget-used; if (remaining<=0) break;
    const chunk=w.slice(0,remaining); out.push(chunk); used+=chunk.length;
  }
  return out.join('\n\n[…]\n\n');
}

function auxiliaryIndex(canonicalDocs, keywords) {
  return canonicalDocs.map((d,i)=>{
    const text=d.text || JSON.stringify(d.summary || {});
    const nameText=normalizeKey(`${d.source?.name||''} ${d.source?.relativePath||''}`);
    let score=0;
    for (const kw of keywords) if (nameText.includes(normalizeKey(kw))) score+=4;
    const lower=normalizeKey(text.slice(0,120000));
    for (const kw of keywords) if (lower.includes(normalizeKey(kw))) score+=1;
    if (/ata|relatorio|relatório|contrato|planejamento|cronograma|baseline|programa/i.test(nameText)) score+=3;
    return { index:i,name:d.source?.name,path:d.source?.relativePath,role:d.role,score,summary:d.summary || null,coverage:d.coverage || null };
  }).sort((a,b)=>b.score-a.score);
}

function buildPreparedContext({ snapshot, projects, aux, prompt }) {
  const keywords=keywordsFromPrompt(prompt);
  const orderedProjects=[...projects].sort((a,b)=>versionTime(a)-versionTime(b));
  const selected=orderedProjects.slice(-3);
  const availableVersions=orderedProjects.map((d,index)=>({
    id:`schedule_${index+1}`, source:d.source, projectInfo:d.projectInfo, taskCount:d.tasks?.length||0,
    statusDate:d.projectInfo?.StatusDate || d.projectInfo?.CurrentDate || null,
    finish:d.projectInfo?.FinishDate || null, baselineFinish:projectMetrics(d)?.baselineFinish || null,
  }));
  const current=selected[selected.length-1] || null;
  const metrics=current ? projectMetrics(current) : null;
  const comparisons=[];
  for (let i=1;i<selected.length;i++) comparisons.push({ from:selected[i-1].source, to:selected[i].source, changes:compareProjects(selected[i-1],selected[i]) });

  const currentForAi=current ? {
    source:current.source, projectInfo:current.projectInfo,
    tasks:(current.tasks||[]).map(t=>pick(t,TASK_KEYS)),
    metrics,
  } : null;

  const auxIdx=auxiliaryIndex(aux,keywords);
  const auxiliaryEvidence=[];
  const perDoc=Math.max(2500,Number(config.aiAuxSnippetChars || 6500));
  const maxAux=Math.max(5,Number(config.aiMaxAuxDocuments || 30));
  for (const item of auxIdx.slice(0,maxAux)) {
    const d=aux[item.index];
    auxiliaryEvidence.push({ source:d.source, role:d.role, score:item.score, coverage:d.coverage || null, summary:d.summary || null, evidence:relevantSnippets(d.text || JSON.stringify(d.machine||{}),keywords,perDoc) });
  }

  const documentIndex=auxIdx.map(x=>({name:x.name,path:x.path,role:x.role,score:x.score,coverage:x.coverage,summary:x.summary}));
  // Todo documento do projeto participa do Contexto canônico. Para manter
  // o custo controlado, cada documento auxiliar tem um digest determinístico curto e
  // os mais relevantes recebem evidência expandida. O JSON mestre integral + OCR
  // permanece no SQLite e pode ser baixado pela tela Dados.
  const allDocumentDigests=aux.map(d=>({
    source:d.source,
    role:d.role,
    coverage:d.coverage || null,
    summary:d.summary || null,
    digest:d.role === 'spreadsheet'
      ? {sheetNames:d.sheetNames || [],sheets:(d.sheets||[]).map(x=>({name:x.name,rowCount:x.rowCount,sampleRows:(x.sampleRows||[]).slice(0,8)})),text:stableText(d.text||'').slice(0,3500)}
      : {text:stableText(d.text || '').slice(0,5000),metadata:d.metadata || null,metrics:d.metrics || null},
  }));
  return {
    schemaVersion:2,
    contextType:'Contexto canônico para IA',
    purpose:'ÚNICO JSON de dados da obra permitido como entrada da etapa de IA. O banco mestre permanece integral no SQLite.',
    package:{ name:'cronograma-html-tools', locked:true, profileHash:packageProfile().packageHash },
    snapshot:{ id:snapshot.id,area:snapshot.area,obra:snapshot.obra,projectBase:snapshot.projectBase || snapshot.folder?.projectBase || 'GO',folder:snapshot.folder,totals:snapshot.totals },
    selectedScheduleVersions:selected.map(d=>({source:d.source,projectInfo:d.projectInfo,taskCount:d.tasks?.length||0})),
    schedule:{ availableVersions, current:currentForAi, comparisons, metrics },
    auxiliary:{ documentIndex, allDocumentDigests, selectedEvidence:auxiliaryEvidence },
    traceability:{ masterJsonPreserved:true, note:'Use source.name/source.relativePath para rastrear qualquer evidência até o JSON mestre no SQLite. A IA não recebe o mestre diretamente.' },
  };
}

export function prepareSnapshotForAi(snapshotId) {
  const snapshot=loadSnapshotFromDatabase(snapshotId);
  if (snapshot.status === 'processing') throw new Error('A sincronização ainda está processando. Aguarde o encerramento antes de preparar a IA.');
  const packagePrompt=loadPackageInstructions().prompt;
  const prompt=packagePrompt;
  const keywords=keywordsFromPrompt(prompt);
  const docs=[]; let masterCharacters=0;
  for (const file of snapshot.files) {
    if (!file.artifactKey) continue;
    const artifact=loadArtifactFromDatabase(file.artifactId || file.artifactKey);
    masterCharacters += Number(artifact.analysisCorpus?.stats?.combinedCharacters || 0);
    docs.push(compactArtifact(file,artifact,keywords));
  }
  const projects=docs.filter(d=>d.role==='schedule_native');
  const aux=docs.filter(d=>d.role!=='schedule_native');
  const canonicalContext=buildPreparedContext({ snapshot,projects,aux,prompt });
  const canonicalText=JSON.stringify(canonicalContext);
  const preparedCharacters=canonicalText.length;
  const reductionPct=masterCharacters ? Math.max(0,(1-(preparedCharacters/masterCharacters))*100) : 0;
  const canonicalHash=crypto.createHash('sha256').update(canonicalText).digest('hex');
  const profile=packageProfile();
  const prep={
    id:createPreparationId(snapshotId), snapshotId, status:'ready', createdAt:new Date().toISOString(),
    contract:{ aiInput:'Contexto canônico para IA', packageLocked:true, packageHash:profile.packageHash, canonicalHash },
    stats:{ masterCharacters,preparedCharacters,estimatedTokens:tokenEstimate(preparedCharacters),reductionPct:Number(reductionPct.toFixed(2)),projectDocuments:projects.length,auxiliaryDocuments:aux.length,documentsInIndex:canonicalContext.auxiliary.documentIndex.length,documentsWithExpandedEvidence:canonicalContext.auxiliary.selectedEvidence.length },
    schedule:{ selectedVersions:canonicalContext.selectedScheduleVersions, metrics:canonicalContext.schedule.metrics, comparisons:canonicalContext.schedule.comparisons.map(x=>({from:x.from,to:x.to,changes:x.changes.length})) },
    canonicalContext,
  };
  return savePreparation(prep);
}
