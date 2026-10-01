import crypto from 'node:crypto';
import { loadArtifactFromDatabase } from '../db/snapshotRepository.js';
import { qualificationForAi } from './chatQualification.js';

const TASK_KEYS=['UID','ID','Name','WBS','OutlineNumber','OutlineLevel','Start','Finish','Duration','PercentComplete','PercentWorkComplete','PhysicalPercentComplete','ActualStart','ActualFinish','RemainingDuration','ConstraintType','ConstraintDate','Deadline','Critical','Milestone','Summary','TotalSlack','FreeSlack','CalendarUID','Notes','Baselines','Predecessors','CustomFields','Active'];
function arr(v){return Array.isArray(v)?v:(v==null?[]:[v]);}
function s(v=''){return String(v??'').trim();}
function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function pick(o,keys){const out={};for(const k of keys)if(o?.[k]!==undefined&&o?.[k]!==null&&o?.[k]!=='')out[k]=o[k];return out;}
function bool(v){return v===true||v===1||String(v).toLowerCase()==='true';}
function date(v){if(!v)return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d;}
function days(a,b){const da=date(a),db=date(b);return da&&db?Math.round((db-da)/86400000):null;}
function pct(t){return n(t?.PercentComplete)??n(t?.PhysicalPercentComplete)??n(t?.PercentWorkComplete)??0;}
function slack(v){if(v==null||v==='')return null;if(typeof v==='number')return v;const m=String(v).match(/-?\d+(?:[.,]\d+)?/);return m?Number(m[0].replace(',','.')):null;}
function baselineFinish(t){const b=arr(t?.Baselines)[0]||{};return b.Finish||b.BaselineFinish||null;}
function taskKey(t){return s(t?.UID||t?.ID||`${t?.WBS||''}|${t?.Name||''}`);}
function sourceKey(src={}){return s(src.relativePath||src.name).toLowerCase().replace(/\\/g,'/');}
function versionTime(doc){const info=doc.projectInfo||{};return date(info.StatusDate||info.CurrentDate||doc.source?.modifiedTime)?.getTime()||0;}

function compactProjectFromArtifact(file,artifact){
  const p=artifact?.machine?.project||{};
  return {role:'schedule_native',source:{name:file.name,relativePath:file.relativePath,modifiedTime:file.modifiedTime,ext:file.ext},projectInfo:p.projectInfo||{},tasks:arr(p.tasks).map(t=>pick(t,TASK_KEYS)),resources:arr(p.resources).map(r=>pick(r,['UID','ID','Name','Type','Initials','Group'])),calendars:arr(p.calendars).map(c=>pick(c,['UID','Name','IsBaseCalendar','BaseCalendarUID'])),coverage:artifact.coverage||null};
}
function projectMetrics(doc){
  const info=doc.projectInfo||{},statusDate=info.StatusDate||info.CurrentDate||null,tasks=doc.tasks||[];
  const incomplete=tasks.filter(t=>!bool(t.Summary)&&pct(t)<100&&!t.ActualFinish);
  const overdue=incomplete.filter(t=>date(t.Finish)&&date(statusDate)&&date(t.Finish)<date(statusDate));
  const critical=incomplete.filter(t=>bool(t.Critical)||(slack(t.TotalSlack)!=null&&slack(t.TotalSlack)<=0));
  const milestones=tasks.filter(t=>bool(t.Milestone)||(s(t.Duration).startsWith('PT0')&&!bool(t.Summary)));
  const gate=[...critical].sort((a,b)=>(date(a.Finish)?.getTime()||Infinity)-(date(b.Finish)?.getTime()||Infinity))[0]||null;
  const bfs=tasks.map(baselineFinish).filter(Boolean).sort();
  return {statusDate,start:info.StartDate||null,finish:info.FinishDate||null,baselineFinish:bfs.at(-1)||null,totalTasks:tasks.length,incompleteTasks:incomplete.length,overdueCount:overdue.length,criticalCount:critical.length,milestoneCount:milestones.length,overdue:overdue.map(t=>({uid:t.UID,id:t.ID,wbs:t.WBS,name:t.Name,start:t.Start,finish:t.Finish,pct:pct(t),critical:bool(t.Critical),slack:t.TotalSlack,baselineFinish:baselineFinish(t)})),criticalPath:critical.map(t=>({uid:t.UID,id:t.ID,wbs:t.WBS,name:t.Name,start:t.Start,finish:t.Finish,pct:pct(t),slack:t.TotalSlack,predecessors:t.Predecessors||[]})),milestones:milestones.map(t=>({uid:t.UID,id:t.ID,wbs:t.WBS,name:t.Name,start:t.Start,finish:t.Finish,pct:pct(t),critical:bool(t.Critical),slack:t.TotalSlack,baselineFinish:baselineFinish(t)})),nextGate:gate?{uid:gate.UID,id:gate.ID,wbs:gate.WBS,name:gate.Name,start:gate.Start,finish:gate.Finish,pct:pct(gate),slack:gate.TotalSlack}:null};
}
function compareProjects(previous,current){
  const prev=new Map((previous.tasks||[]).map(t=>[taskKey(t),t])),changes=[];
  for(const t of current.tasks||[]){const old=prev.get(taskKey(t));if(!old)continue;const df=days(old.Finish,t.Finish),ds=days(old.Start,t.Start),pd=pct(t)-pct(old);if((df||0)!==0||(ds||0)!==0||pd!==0)changes.push({uid:t.UID,id:t.ID,wbs:t.WBS,name:t.Name,critical:bool(t.Critical),previous:{start:old.Start,finish:old.Finish,pct:pct(old)},current:{start:t.Start,finish:t.Finish,pct:pct(t)},deltaStartDays:ds,deltaFinishDays:df,deltaPctPoints:pd});}
  return changes.sort((a,b)=>Math.abs(b.deltaFinishDays||0)-Math.abs(a.deltaFinishDays||0));
}
function selectedVersionKeys(session,basePreparation){
  const q=qualificationForAi(session), selected=arr(q.comparisonPeriods).filter(Boolean);
  if(selected.length) return selected.map(x=>String(x).toLowerCase().replace(/\\/g,'/'));
  return arr(basePreparation?.canonicalContext?.selectedScheduleVersions).map(v=>sourceKey(v.source));
}
function matchCustomVersions(session,available=[]){
  const custom=s(session?.state?.answers?.comparisonCustom);if(!custom)return [];
  const nums=[...custom.matchAll(/(?:sem(?:ana)?\s*)?(\d{1,3})/gi)].map(m=>m[1]);
  return available.filter(v=>nums.some(num=>new RegExp(`sem(?:ana)?\\s*[-_ ]?${num}(?:\\D|$)`,'i').test(v?.source?.name||v?.source?.relativePath||''))).map(v=>sourceKey(v.source));
}
function changedFileEvidence(snapshot){
  const actions=new Set(['new','modified','retry','renamed','deleted']); const out=[];
  for(const f of snapshot.files||[]){if(!actions.has(f.syncAction))continue;const row={action:f.syncAction,status:f.status,name:f.name,relativePath:f.relativePath,previousRelativePath:f.previousRelativePath||null,modifiedTime:f.modifiedTime||null,ext:f.ext||null,error:f.error||null};
    if(f.artifactId&&f.syncAction!=='deleted'){
      try{const a=loadArtifactFromDatabase(f.artifactId);const txt=String(a.nativeText||a.text||a.ocrText||'').replace(/\s+/g,' ').slice(0,12000);row.kind=a.kind||null;row.summary=a.technicalSummary||null;row.evidence=txt;}catch{}
    }
    out.push(row);
  }
  return out;
}
function resultForUpdate(result){
  if(!result)return null;
  return {generatedAt:result.generatedAt||null,executiveSummary:result.executiveSummary||[],kitConfig:result.kitConfig||null,analysis:result.analysis||result.scheduleAnalysis||null,findings:result.findings||result.keyFindings||null,assumptions:result.assumptions||result.premises||null,traceability:result.traceability||null,packageCompliance:result.packageCompliance||null};
}

export function buildSessionAnalysisPreparation({session,snapshot,basePreparation,previousVersion=null,previousResult=null}){
  const available=arr(basePreparation?.canonicalContext?.schedule?.availableVersions).length?arr(basePreparation.canonicalContext.schedule.availableVersions):arr(basePreparation?.canonicalContext?.selectedScheduleVersions);
  let keys=new Set([...selectedVersionKeys(session,basePreparation),...matchCustomVersions(session,available)]);
  if(!keys.size) available.slice(-3).forEach(v=>keys.add(sourceKey(v.source)));
  const selected=[];
  for(const v of available){const k=sourceKey(v.source);if(!keys.has(k))continue;const file=(snapshot.files||[]).find(f=>sourceKey(f)===k||s(f.name).toLowerCase()===s(v?.source?.name).toLowerCase());if(!file?.artifactId)continue;try{const artifact=loadArtifactFromDatabase(file.artifactId);if(artifact?.machine?.project)selected.push(compactProjectFromArtifact(file,artifact));}catch{}}
  selected.sort((a,b)=>versionTime(a)-versionTime(b));
  if(!selected.length){ // fallback seguro para instalações antigas
    const current=basePreparation?.canonicalContext?.schedule?.current; if(current) selected.push(current);
  }
  const current=selected.at(-1)||null,metrics=current?projectMetrics(current):{}; const comparisons=[];
  for(let i=1;i<selected.length;i++)comparisons.push({from:selected[i-1].source,to:selected[i].source,changes:compareProjects(selected[i-1],selected[i])});
  const qualification=qualificationForAi(session); const isUpdate=Boolean(previousVersion&&previousResult);
  const baseAux=basePreparation?.canonicalContext?.auxiliary||{};
  const delta=changedFileEvidence(snapshot);
  const context={schemaVersion:3,contextType:'Contexto canônico para IA',purpose:isUpdate?'Camada incremental: atualizar o último resultado usando somente os períodos escolhidos, o delta do banco e o pedido do usuário.':'Camada de análise por períodos: gerar a primeira versão usando somente os períodos escolhidos e o contexto canônico já preparado.',package:basePreparation?.canonicalContext?.package||{},snapshot:{...(basePreparation?.canonicalContext?.snapshot||{}),id:snapshot.id,totals:snapshot.totals},selectedScheduleVersions:selected.map(d=>({source:d.source,projectInfo:d.projectInfo,taskCount:d.tasks?.length||0})),schedule:{availableVersions:available,current:current?{source:current.source,projectInfo:current.projectInfo,tasks:current.tasks,metrics}:null,comparisons,metrics},auxiliary:isUpdate?{documentIndex:baseAux.documentIndex||[],allDocumentDigests:[],selectedEvidence:delta}:{documentIndex:baseAux.documentIndex||[],allDocumentDigests:baseAux.allDocumentDigests||[],selectedEvidence:baseAux.selectedEvidence||[]},userQualification:qualification,analysisLayer:{mode:isUpdate?'incremental_update':'initial_period_analysis',periodicity:qualification.periodicity,requestedPeriods:qualification.comparisonPeriods,customComparison:qualification.comparisonCustom||null,requestedChange:qualification.userRequest||null,parentVersion:previousVersion?{id:previousVersion.id,versionNo:previousVersion.versionNo,analysisId:previousVersion.analysisId,completedAt:previousVersion.completedAt}:null,previousResult:isUpdate?resultForUpdate(previousResult):null,deltaFiles:delta,rule:isUpdate?'Parta do resultado anterior. Atualize apenas conclusões afetadas pelos períodos escolhidos, por arquivos novos/modificados/removidos/renomeados ou pela solicitação explícita do usuário. Preserve o restante do resultado anterior.':'Gere a análise somente com os períodos escolhidos e a qualificação do usuário.'},traceability:{masterJsonPreserved:true,incremental:Boolean(isUpdate),note:'Os dados desta camada foram montados do SQLite. Em atualização, nenhuma releitura integral da pasta foi feita; somente o delta e as versões escolhidas foram carregados.'}};
  const text=JSON.stringify(context); const hash=crypto.createHash('sha256').update(text).digest('hex');
  return {...basePreparation,id:`${basePreparation.id}_session`,contract:{...(basePreparation.contract||{}),canonicalHash:hash},stats:{...(basePreparation.stats||{}),preparedCharacters:text.length,estimatedTokens:Math.ceil(text.length/2.5)},schedule:{selectedVersions:context.selectedScheduleVersions,metrics,comparisons:comparisons.map(x=>({from:x.from,to:x.to,changes:x.changes.length}))},canonicalContext:context};
}
