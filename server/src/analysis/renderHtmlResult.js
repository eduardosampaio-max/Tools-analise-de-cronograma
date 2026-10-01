import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { loadArtifactFromDatabase } from '../db/snapshotRepository.js';

const ROOT = path.join(config.serverRoot, 'kit', 'cronograma-html-tools');
const RENDERER = path.join(ROOT, 'scripts', 'gerar_html.py');
const OUTPUT_ROOT = path.join(config.dataDir, 'ai-results');

function arr(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
function val(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('#text' in v) return val(v['#text']);
    if ('value' in v) return val(v.value);
  }
  return String(v);
}
function int(v) { const n=Number(val(v)); return Number.isFinite(n) ? Math.trunc(n) : null; }
function bool(v) {
  if (typeof v === 'boolean') return v;
  const s=String(val(v) ?? '').trim().toLowerCase();
  if (['true','1','yes','sim'].includes(s)) return true;
  if (['false','0','no','nao','não',''].includes(s)) return false;
  return Boolean(v);
}
function date(v) {
  const s=val(v);
  if (!s) return null;
  return s.length >= 16 ? s.slice(0,16) : s;
}
function durationText(v, minutesPerDay=480) {
  const s=val(v); if (!s) return null;
  const m=s.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return s;
  const d=Number(m[1]||0),h=Number(m[2]||0),min=Number(m[3]||0),sec=Number(m[4]||0);
  const totalMinutes=d*minutesPerDay+h*60+min+sec/60;
  const days=totalMinutes/Math.max(1,Number(minutesPerDay)||480);
  return `${Number(days.toFixed(2))}d`;
}
function safeId(v='') { return String(v).replace(/[^a-zA-Z0-9._-]/g,'_'); }
function safeFilename(v='') {
  return String(v || 'Cronograma').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'');
}
function normalizePath(v='') { return String(v).replaceAll('\\','/').replace(/^\.\//,'').toLowerCase(); }
function scalar(o, ...keys) {
  for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null && o?.[k] !== '') return o[k];
  return null;
}
function baseline(task) {
  const list=arr(task?.Baselines || task?.Baseline);
  return list.find(b => String(scalar(b,'Number','BaselineNumber') ?? '0') === '0') || list[0] || {};
}
function normalizeCustomKey(v='') {
  const raw=String(v || '').trim();
  const m=raw.match(/\b(?:text|string)\s*([1-9]|10)\b/i); if (m) return `text${m[1]}`;
  const n=raw.match(/\b(?:number|num)\s*([1-5])\b/i); if (n) return `num${n[1]}`;
  const f=raw.match(/\bflag\s*([1-5])\b/i); if (f) return `flag${f[1]}`;
  return raw.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}
function resourceNameMap(project) {
  const map=new Map();
  for (const r of arr(project?.resources)) {
    const uid=val(scalar(r,'UID','UniqueID','ID'));
    if (uid) map.set(uid, val(scalar(r,'Name','ResourceName')) || uid);
  }
  return map;
}
function resourcesByTask(project) {
  const names=resourceNameMap(project); const map=new Map();
  for (const a of arr(project?.assignments)) {
    const taskUid=val(scalar(a,'TaskUID','TaskUniqueID')); const resUid=val(scalar(a,'ResourceUID','ResourceUniqueID'));
    if (!taskUid || !resUid) continue;
    if (!map.has(taskUid)) map.set(taskUid,[]);
    const name=names.get(resUid); if (name && !map.get(taskUid).includes(name)) map.get(taskUid).push(name);
  }
  return map;
}
function fieldDefinitions(project) {
  const byId=new Map(); const custom=[];
  for (const def of arr(project?.extendedAttributeDefinitions)) {
    const id=val(scalar(def,'FieldID','FieldId'));
    const fieldName=val(scalar(def,'FieldName','Name','FieldType'));
    const alias=val(scalar(def,'Alias','Description'));
    const key=normalizeCustomKey(fieldName || alias || id);
    if (id && key) byId.set(id,{ key, alias:alias || fieldName || key });
    if (key && alias) custom.push({ campo:key, alias });
  }
  return { byId, customFields:[...new Map(custom.map(x=>[`${x.campo}|${x.alias}`,x])).values()] };
}
function predecessorText(link) {
  const predId=int(scalar(link,'PredecessorUID','PredecessorTaskUID','PredecessorID'));
  const type=val(scalar(link,'Type','LinkType')) || '';
  const lag=val(scalar(link,'LinkLag','Lag')) || '';
  return predId == null ? null : `${predId}${type}${lag}`;
}
export function projectToRaw(project, source={}) {
  const info=project?.projectInfo || {};
  const resByTask=resourcesByTask(project);
  const defs=fieldDefinitions(project);
  const minutesPerDay=Number(val(scalar(info,'MinutesPerDay'))) || 480;
  const tasks=[];
  for (const t of arr(project?.tasks)) {
    const id=int(scalar(t,'ID'));
    if (id == null) continue;
    const b=baseline(t);
    const uid=int(scalar(t,'UID','UniqueID'));
    const row={
      id, uid:uid ?? id, wbs:val(scalar(t,'WBS','OutlineNumber')), level:int(scalar(t,'OutlineLevel')),
      name:val(scalar(t,'Name')), summary:bool(scalar(t,'Summary')), milestone:bool(scalar(t,'Milestone')),
      active:scalar(t,'Active') == null ? true : bool(scalar(t,'Active')), dur:durationText(scalar(t,'Duration'),minutesPerDay),
      start:date(scalar(t,'Start')), finish:date(scalar(t,'Finish')),
      actual_start:date(scalar(t,'ActualStart')), actual_finish:date(scalar(t,'ActualFinish')),
      bl_start:date(scalar(b,'Start','BaselineStart')), bl_finish:date(scalar(b,'Finish','BaselineFinish')), bl_dur:durationText(scalar(b,'Duration','BaselineDuration'),minutesPerDay),
      pct:val(scalar(t,'PercentComplete')), pct_work:val(scalar(t,'PercentWorkComplete')), phys_pct:val(scalar(t,'PhysicalPercentComplete')),
      critical:bool(scalar(t,'Critical')), total_slack:durationText(scalar(t,'TotalSlack'),minutesPerDay), free_slack:durationText(scalar(t,'FreeSlack'),minutesPerDay),
      finish_var:val(scalar(t,'FinishVariance','FinishVar')), start_var:val(scalar(t,'StartVariance','StartVar')),
      constraint:val(scalar(t,'ConstraintType')), constraint_date:date(scalar(t,'ConstraintDate')), deadline:date(scalar(t,'Deadline')),
      notes:val(scalar(t,'Notes')), preds:arr(t?.Predecessors).map(predecessorText).filter(Boolean),
      resources:resByTask.get(String(uid ?? '')) || [], cost:val(scalar(t,'Cost')), bl_cost:val(scalar(b,'Cost','BaselineCost')), work:val(scalar(t,'Work')),
    };
    for (let i=1;i<=10;i++) row[`text${i}`]=null;
    for (let i=1;i<=5;i++) { row[`num${i}`]=null; row[`flag${i}`]=null; }
    for (const cf of arr(t?.CustomFields)) {
      const fieldId=val(scalar(cf,'fieldId','FieldID','FieldId'));
      const direct=normalizeCustomKey(val(scalar(cf,'fieldName','FieldName')) || '');
      const def=fieldId ? defs.byId.get(fieldId) : null;
      const key=direct || def?.key;
      if (!key) continue;
      const value=val(scalar(cf,'value','Value','Description','DurationValue','DateValue','NumericValue'));
      row[key]=/^flag\d+$/.test(key) ? bool(value) : value;
    }
    tasks.push(row);
  }
  const projectSummary=tasks.find(t=>t.id===0) || tasks.find(t=>t.summary && (t.level===0 || t.level===1)) || null;
  const baselineFinish=date(scalar(info,'BaselineFinish')) || projectSummary?.bl_finish || tasks.map(t=>t.bl_finish).filter(Boolean).sort().at(-1) || null;
  const pctComplete=val(scalar(info,'PercentComplete','PercentageComplete')) || projectSummary?.pct || null;
  return {
    info:{
      arquivo:source.relativePath || source.name || '', titulo:val(scalar(info,'Title','Name')) || source.name || '',
      autor:val(scalar(info,'Author')), empresa:val(scalar(info,'Company')), status_date:date(scalar(info,'StatusDate','CurrentDate')),
      start:date(scalar(info,'StartDate')), finish:date(scalar(info,'FinishDate')), baseline_finish:baselineFinish,
      last_saved:date(scalar(info,'LastSaved')), pct_complete:pctComplete,
    },
    tasks,
    custom_fields:defs.customFields,
  };
}
function findSnapshotFile(snapshot, source={}) {
  const target=normalizePath(source.relativePath || '');
  if (target) {
    const exact=snapshot.files.find(f=>normalizePath(f.relativePath)===target && f.artifactId);
    if (exact) return exact;
  }
  const name=String(source.name || '').toLowerCase();
  const matches=snapshot.files.filter(f=>String(f.name||'').toLowerCase()===name && f.artifactId);
  if (matches.length===1) return matches[0];
  if (matches.length>1 && source.modifiedTime) {
    const stamp=new Date(source.modifiedTime).getTime();
    return matches.sort((a,b)=>Math.abs(new Date(a.modifiedTime||0).getTime()-stamp)-Math.abs(new Date(b.modifiedTime||0).getTime()-stamp))[0];
  }
  return matches[0] || null;
}
function versionTag(preparedResult, preparation) {
  const cfgVersions=arr(preparedResult?.kitConfig?.versoes);
  const last=cfgVersions.at(-1);
  if (last?.rotulo) { const sf=safeFilename(last.rotulo); const m=sf.match(/^sem(?:ana)?_?(\d+)$/i); return m ? `Sem${m[1]}` : sf; }
  const current=preparation?.canonicalContext?.selectedScheduleVersions?.at(-1)?.source?.name || 'Atual';
  const m=String(current).match(/sem(?:ana)?\s*[-_ ]?(\d+)/i); return m ? `Sem${m[1]}` : 'Atual';
}
function versionLabelFromSource(source={},i=0) {
  const name=String(source.name || source.relativePath || '');
  const sem=name.match(/sem(?:ana)?\s*[-_ ]?(\d+)/i);
  if (sem) return `Sem ${sem[1]}`;
  const rev=name.match(/rev(?:is[aã]o)?\s*[-_ ]?(\d+)/i);
  if (rev) return `Rev ${rev[1]}`;
  return `Versão ${i+1}`;
}
function normalizedVersions(preparedResult, selected) {
  const cfg=arr(preparedResult?.kitConfig?.versoes);
  const aligned=cfg.length===selected.length;
  return selected.map((v,i)=>{
    const c=aligned ? (cfg[i] || {}) : {};
    return { key:String(c.key || `v${i+1}`), rotulo:String(c.rotulo || versionLabelFromSource(v.source,i)), ...(c.status ? {status:c.status}:{}), ...(c.salvo ? {salvo:c.salvo}:{}), ...(c.data_status ? {data_status:c.data_status}:{}) };
  });
}
function pythonCandidates() {
  const explicit=String(process.env.PYTHON_BIN || '').trim();
  const out=[];
  if (explicit) out.push({cmd:explicit,args:[]});
  if (process.platform === 'win32') out.push({cmd:'python',args:[]},{cmd:'py',args:['-3']},{cmd:'python3',args:[]});
  else out.push({cmd:'python3',args:[]},{cmd:'python',args:[]});
  return out.filter((x,i,a)=>a.findIndex(y=>y.cmd===x.cmd && y.args.join(' ')===x.args.join(' '))===i);
}
function spawnCapture(cmd,args,{cwd,timeoutMs=180000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{cwd,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    let stdout='',stderr='',settled=false;
    const finish=(fn,value)=>{ if (settled) return; settled=true; clearTimeout(timer); fn(value); };
    child.stdout.on('data',d=>stdout+=d.toString('utf8'));
    child.stderr.on('data',d=>stderr+=d.toString('utf8'));
    child.on('error',e=>finish(reject,e));
    child.on('close',code=>finish(resolve,{code,stdout,stderr}));
    const timer=setTimeout(()=>{ try { child.kill('SIGKILL'); } catch {} finish(reject,new Error(`gerar_html.py excedeu ${Math.round(timeoutMs/1000)}s`)); },timeoutMs);
  });
}
async function runRenderer(configPath,{summary=false}={}) {
  let missing=[];
  for (const candidate of pythonCandidates()) {
    try {
      const args=[...candidate.args,RENDERER,configPath]; if (summary) args.push('--resumo');
      const result=await spawnCapture(candidate.cmd,args,{cwd:path.dirname(configPath)});
      if (result.code===0) return { ...result, python:[candidate.cmd,...candidate.args].join(' ') };
      const err=new Error(`gerar_html.py retornou código ${result.code}: ${(result.stderr||result.stdout).slice(-3000)}`); err.rendererResult=result; throw err;
    } catch (error) {
      if (error?.code === 'ENOENT') { missing.push(candidate.cmd); continue; }
      throw error;
    }
  }
  throw new Error(`Python não encontrado para executar a skill. Tentativas: ${missing.join(', ') || 'nenhuma'}. Configure PYTHON_BIN ou instale Python 3.`);
}
export function aiResultOutputDir(id) { return path.join(OUTPUT_ROOT,safeId(id)); }
export function renderManifestPath(id) { return path.join(aiResultOutputDir(id),'render-manifest.json'); }
export async function loadRenderManifest(id) {
  const file=renderManifestPath(id); if (!fs.existsSync(file)) throw new Error('HTML Tools ainda não foi gerado para esta análise.');
  return JSON.parse(await fsp.readFile(file,'utf8'));
}

export async function renderHtmlResult({ analysisId, snapshot, preparation, preparedResult, onProgress=()=>{} }) {
  if (!preparedResult?.kitConfig) throw new Error('Resultado preparado não contém kitConfig para o renderer da skill.');
  if (!fs.existsSync(RENDERER)) throw new Error('Pacote cronograma-html-tools incompleto: scripts/gerar_html.py não encontrado.');
  const selected=arr(preparation?.canonicalContext?.selectedScheduleVersions);
  if (!selected.length) throw new Error('Contexto canônico não informa versões nativas selecionadas.');
  onProgress({phase:'render_prepare',message:'Preparando dados nativos para o kit HTML…'});
  const versions=normalizedVersions(preparedResult,selected);
  const raw={}; const sources=[];
  for (let i=0;i<selected.length;i++) {
    const file=findSnapshotFile(snapshot,selected[i].source || {});
    if (!file) throw new Error(`Não foi possível localizar no SQLite a versão nativa usada no Contexto canônico: ${selected[i]?.source?.relativePath || selected[i]?.source?.name || `versão ${i+1}`}.`);
    const artifact=loadArtifactFromDatabase(file.artifactId || file.artifactKey);
    const project=artifact?.machine?.project;
    if (!project) throw new Error(`O artefato ${file.relativePath || file.name} não possui estrutura Project necessária ao gerar_html.py.`);
    raw[versions[i].key]=projectToRaw(project,{name:file.name,relativePath:file.relativePath});
    sources.push({key:versions[i].key,name:file.name,relativePath:file.relativePath,artifactId:file.artifactId,contentHash:artifact.contentHash || file.contentHash || null});
  }
  const outDir=aiResultOutputDir(analysisId); await fsp.mkdir(outDir,{recursive:true});
  const sigla=safeFilename(snapshot.obra || 'OBRA'); const tag=versionTag(preparedResult,preparation);
  const htmlName=`${sigla}_Cronograma_Marcos_${tag}.html`;
  const rawName='versoes_raw.json'; const cfgName='config.json';
  const rawPath=path.join(outDir,rawName); const cfgPath=path.join(outDir,cfgName); const htmlPath=path.join(outDir,htmlName);
  await fsp.writeFile(rawPath,JSON.stringify(raw,null,2),'utf8');
  const kitConfig=JSON.parse(JSON.stringify(preparedResult.kitConfig));
  kitConfig.raw=rawName; kitConfig.saida=htmlName; kitConfig.versoes=versions;
  await fsp.writeFile(cfgPath,JSON.stringify(kitConfig,null,2),'utf8');
  onProgress({phase:'render_validate',message:'Conferindo pareamento do config com gerar_html.py --resumo…'});
  const summary=await runRenderer(cfgPath,{summary:true});
  onProgress({phase:'render_html',message:'Gerando HTML padrão TOOLS com o template da skill…'});
  const generated=await runRenderer(cfgPath,{summary:false});
  if (!fs.existsSync(htmlPath)) throw new Error('gerar_html.py terminou sem criar o HTML esperado.');
  const html=await fsp.readFile(htmlPath,'utf8');
  for (const marker of ['<!DOCTYPE html>','id="kpis"','id="chart"','id="tbl"','id="notes"','const META =','const DATA =','const MS =']) if (!html.includes(marker)) throw new Error(`HTML gerado falhou na validação: marcador ausente ${marker}`);
  const base=htmlPath.replace(/\.html$/i,'');
  const dataPath=`${base}_dados.json`; const csvPath=`${base}_memoria_confronto.csv`;
  const preparedCopy=path.join(outDir,'resultado-preparado.json');
  await fsp.writeFile(preparedCopy,JSON.stringify(preparedResult,null,2),'utf8');
  const manifest={
    schemaVersion:'tools.cronograma.render.v1', analysisId, generatedAt:new Date().toISOString(),
    package:'cronograma-html-tools', renderer:'scripts/gerar_html.py', template:'assets/cronograma_marcos_template.html',
    html:{name:htmlName,path:htmlPath,bytes:(await fsp.stat(htmlPath)).size},
    data:fs.existsSync(dataPath)?{name:path.basename(dataPath),path:dataPath,bytes:(await fsp.stat(dataPath)).size}:null,
    csv:fs.existsSync(csvPath)?{name:path.basename(csvPath),path:csvPath,bytes:(await fsp.stat(csvPath)).size}:null,
    config:{name:cfgName,path:cfgPath}, raw:{name:rawName,path:rawPath}, preparedResult:{name:path.basename(preparedCopy),path:preparedCopy},
    sources, python:generated.python, preflight:{stdout:summary.stdout.slice(-12000),stderr:summary.stderr.slice(-4000)}, render:{stdout:generated.stdout.slice(-12000),stderr:generated.stderr.slice(-4000)},
  };
  await fsp.writeFile(renderManifestPath(analysisId),JSON.stringify(manifest,null,2),'utf8');
  return manifest;
}
