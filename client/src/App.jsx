import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertCircle, Bot, Building2, CheckCircle2, ChevronDown, ChevronLeft,
  Database, Download, Eye, FileJson, FolderSync, HardDrive, Home, LoaderCircle,
  MessageSquareText, Play, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles,
  TableProperties, XCircle, Plus, Clock3, Save, Trash2
} from 'lucide-react';
import { api } from './api';

const AREA_FOLDER={RESIDENCIAL:'2_RESIDENCIAL',CORPORATIVO:'3_CORPORATIVO',PREDIAL:'4_PREDIAL'};
const PROJECT_BASES={GO:{label:'GO',title:'Gerenciamento de Obra'},GP:{label:'GP',title:'Gerenciamento de Projetos'}};
const expectedProjectPath=(area,obra,base)=>{
  const root=`G:\\Drives compartilhados\\${AREA_FOLDER[area]}\\${obra}`;
  if(base==='GP') return area==='PREDIAL'?`${root}\\COORD\\CRONOGRAMA`:`${root}\\GP\\COORD\\CRONOGRAMA`;
  return `${root}\\GO\\CRONOGRAMA`;
};
const BU_ORDER=['RESIDENCIAL','CORPORATIVO','PREDIAL'];
const BU_META={
  RESIDENCIAL:{label:'Residencial',description:'Obras residenciais',Icon:Home},
  CORPORATIVO:{label:'Corporativo',description:'Escritórios e ambientes corporativos',Icon:Building2},
  PREDIAL:{label:'Predial',description:'Obras e intervenções prediais',Icon:TableProperties},
};
const terminal=s=>['completed','failed','partial'].includes(s);
const keyOf=o=>`${o.area}::${o.name}`;
const splitKey=value=>{ const [area,...rest]=String(value||'').split('::'); return {area,obra:rest.join('::')}; };
const num=v=>Number(v||0).toLocaleString('pt-BR');

function Badge({children,tone='muted'}){ return <span className={`badge badge-${tone}`}>{children}</span>; }
function StatusBadge({status}){
  const map={completed:['Concluído','ok'],extracted:['Extraído','ok'],partial:['Parcial','warn'],failed:['Falhou','bad'],processing:['Processando','work'],queued:['Na fila','muted'],reused:['Reaproveitado','ok'],unchanged:['Inalterado','muted'],renamed:['Renomeado','ok']};
  const [label,tone]=map[status]||[status||'—','muted']; return <Badge tone={tone}>{label}</Badge>;
}
function ocrLabel(file){
  const o=file?.extraction?.ocr || file?.extraction?.technicalSummary?.ocr || {};
  const kind=String(file?.extraction?.kind||'').toLowerCase();
  const eligible=o.eligible != null ? Boolean(o.eligible) : ['pdf','image'].includes(kind);
  const chars=Number(o.characters||0); const failed=Number(o.failedTargets||0);
  if(!eligible || o.notApplicable) return {text:'OCR N/A',tone:'muted'};
  if(o.pending) return {text:'OCR pendente',tone:'work'};
  if(o.complete===false || failed>0) return {text:`OCR parcial${chars?` · ${num(chars)}`:''}`,tone:'warn'};
  return {text:`OCR ${num(chars)}`,tone:'ok'};
}

function App(){
  const [view,setView]=useState('home');
  const [catalog,setCatalog]=useState([]); const [health,setHealth]=useState(null); const [warnings,setWarnings]=useState([]);
  const [error,setError]=useState(''); const [query,setQuery]=useState('');
  const [projectKey,setProjectKey]=useState(''); const [projectBase,setProjectBase]=useState('GO'); const [homeBu,setHomeBu]=useState('');
  const [baseStatus,setBaseStatus]=useState(null);
  const [expandedBus,setExpandedBus]=useState({RESIDENCIAL:true,CORPORATIVO:true,PREDIAL:true});

  const [dataSnapshot,setDataSnapshot]=useState(null); const [loadingSnapshot,setLoadingSnapshot]=useState(false);
  const [extractionJob,setExtractionJob]=useState(null); const [artifactPreview,setArtifactPreview]=useState(null); const [previewLoading,setPreviewLoading]=useState(false);
  const [syncSchedule,setSyncSchedule]=useState(null); const [scheduleLoading,setScheduleLoading]=useState(false);
  const [scheduleDraft,setScheduleDraft]=useState({enabled:false,times:['07:00','12:00','18:00'],timezone:'America/Sao_Paulo',onAnalysisRefresh:true});

  const [chatSnapshot,setChatSnapshot]=useState(null); const [chatSession,setChatSession]=useState(null); const [chatLoading,setChatLoading]=useState(false);
  const [answerDraft,setAnswerDraft]=useState(''); const [choiceDraft,setChoiceDraft]=useState(''); const [detailDraft,setDetailDraft]=useState('');
  const [analysisVersions,setAnalysisVersions]=useState([]); const [followupMessages,setFollowupMessages]=useState([]); const [followupDraft,setFollowupDraft]=useState(''); const [followupLoading,setFollowupLoading]=useState(false);
  const [aiJob,setAiJob]=useState(null); const [testingAi,setTestingAi]=useState(false); const [aiTest,setAiTest]=useState(null);

  const selected=useMemo(()=>catalog.find(o=>keyOf(o)===projectKey)||null,[catalog,projectKey]);
  const projectsByBu=useMemo(()=>Object.fromEntries(BU_ORDER.map(area=>[area,catalog.filter(o=>o.area===area)])),[catalog]);
  const filtered=useMemo(()=>{
    const q=query.trim().toLowerCase();
    return catalog.filter(o=>(!homeBu||o.area===homeBu)&&(!q||`${o.name} ${o.area}`.toLowerCase().includes(q)));
  },[catalog,query,homeBu]);

  async function bootstrap(){
    setError('');
    try{
      const [c,h]=await Promise.all([api.obras(),api.health()]);
      setCatalog(c.obras||[]); setWarnings(c.warnings||[]); setHealth(h);
    }catch(e){ setError(e.message); }
  }
  useEffect(()=>{ bootstrap(); },[]);

  async function loadAnalysisVersions(area,obra,base=projectBase){
    if(!area||!obra){setAnalysisVersions([]);return [];}
    try{const r=await api.analysisVersions(area,obra,base);setAnalysisVersions(r.items||[]);return r.items||[];}catch{setAnalysisVersions([]);return [];}
  }
  async function loadFollowupMessages(sessionId){
    if(!sessionId){setFollowupMessages([]);return [];}
    try{const r=await api.chatMessages(sessionId);setFollowupMessages(r.items||[]);return r.items||[];}catch{setFollowupMessages([]);return [];}
  }

  async function loadLatestSnapshot(key,{forChat=false,resumeChat=true,base=projectBase}={}){
    if(!key){ if(forChat){setChatSnapshot(null);setChatSession(null);} else setDataSnapshot(null); return null; }
    const {area,obra}=splitKey(key); setLoadingSnapshot(true); setError('');
    try{
      const snap=await api.latestSync(area,obra,base);
      if(forChat){
        setChatSnapshot(snap);
        if(resumeChat){
          try{
            const session=await api.latestChatSession(snap.id);
            setChatSession(session);
            loadFollowupMessages(session?.id);
            loadAnalysisVersions(area,obra,base);
            if(session?.analysisId){
              try{ setAiJob(await api.getAiAnalysis(session.analysisId)); }
              catch{ setAiJob({id:session.analysisId,status:'completed',progress:100,result:{analysisId:session.analysisId,html:true}}); }
            }
          } catch{ setChatSession(null); setFollowupMessages([]); loadAnalysisVersions(area,obra,base); }
        }
      } else setDataSnapshot(snap);
      return snap;
    }catch(e){
      const missing=/ainda não possui a base|ainda não possui base|Nenhuma sincronização/i.test(e.message);
      if(forChat){setChatSnapshot(null);setChatSession(null);} else setDataSnapshot(null);
      if(!missing)setError(e.message);
      return null;
    }finally{ setLoadingSnapshot(false); }
  }

  async function loadBaseStatus(key){
    if(!key){setBaseStatus(null);return null;}
    const {area,obra}=splitKey(key);
    try{const status=await api.projectBaseStatus(area,obra);setBaseStatus(status);return status;}catch{setBaseStatus(null);return null;}
  }

  async function loadSyncSchedule(key,base=projectBase){
    if(!key){setSyncSchedule(null);return null;}
    const {area,obra}=splitKey(key); setScheduleLoading(true);
    try{
      const schedule=await api.getSyncSchedule(area,obra,base);
      setSyncSchedule(schedule);
      setScheduleDraft({enabled:Boolean(schedule.enabled),times:(schedule.times?.length?schedule.times:['07:00','12:00','18:00']),timezone:schedule.timezone||'America/Sao_Paulo',onAnalysisRefresh:schedule.onAnalysisRefresh!==false});
      return schedule;
    }catch(e){setError(e.message);return null;}finally{setScheduleLoading(false);}
  }

  async function saveSyncSchedule(){
    if(!selected)return; setScheduleLoading(true); setError('');
    try{
      const schedule=await api.saveSyncSchedule({area:selected.area,obra:selected.name,base:projectBase,...scheduleDraft});
      setSyncSchedule(schedule);
      setScheduleDraft({enabled:Boolean(schedule.enabled),times:schedule.times||[],timezone:schedule.timezone||'America/Sao_Paulo',onAnalysisRefresh:schedule.onAnalysisRefresh!==false});
    }catch(e){setError(e.message);}finally{setScheduleLoading(false);}
  }

  useEffect(()=>{ loadBaseStatus(projectKey); },[projectKey]);

  useEffect(()=>{
    if(view==='data'){ loadLatestSnapshot(projectKey,{forChat:false,base:projectBase}); loadSyncSchedule(projectKey,projectBase); }
    if(view==='chat'){
      setAiJob(null); setAiTest(null); setAnswerDraft(''); setChoiceDraft(''); setDetailDraft('');
      loadLatestSnapshot(projectKey,{forChat:true,resumeChat:true,base:projectBase});
    }
  },[projectKey,projectBase,view]);

  function watchJob(created,eventUrl,getter,onUpdate,onDone){
    const source=new EventSource(eventUrl(created.id));
    source.onmessage=e=>{
      const next=JSON.parse(e.data); onUpdate(next);
      if(terminal(next.status)){ source.close(); onDone?.(next); }
    };
    source.onerror=async()=>{ source.close(); try{ const next=await getter(created.id); onUpdate(next); if(terminal(next.status))onDone?.(next); }catch{} };
  }

  function openProject(project){
    setProjectKey(keyOf(project));
    setProjectBase('GO');
    setView('chat');
  }

  function goHome(){ setView('home'); setHomeBu(''); setQuery(''); }

  function switchProjectBase(base){
    if(base===projectBase)return;
    setProjectBase(base); setDataSnapshot(null); setChatSnapshot(null); setChatSession(null); setAnalysisVersions([]); setFollowupMessages([]); setFollowupDraft(''); setAiJob(null); setExtractionJob(null); setArtifactPreview(null); setSyncSchedule(null); setError('');
  }

  async function syncProject({retryPartial=false}={}){
    if(!selected)return; setError(''); setArtifactPreview(null);
    setExtractionJob({status:'queued',progress:0,stage:'Preparando sincronização…'});
    try{
      const created=await api.createExtraction({area:selected.area,obra:selected.name,base:projectBase,retryPartial}); setExtractionJob(created);
      watchJob(created,api.extractionEventsUrl,api.getExtraction,setExtractionJob,async()=>{ await loadLatestSnapshot(projectKey,{base:projectBase}); await loadBaseStatus(projectKey); await loadSyncSchedule(projectKey,projectBase); try{setHealth(await api.health());}catch{} });
    }catch(e){ setError(e.message); setExtractionJob(null); }
  }

  async function previewArtifact(index){
    if(!dataSnapshot?.id)return; setPreviewLoading(true); setArtifactPreview(null);
    try{ setArtifactPreview(await api.getArtifactPreview(dataSnapshot.id,index)); }catch(e){setError(e.message);}finally{setPreviewLoading(false);}
  }

  async function startChat(){
    if(!chatSnapshot?.id)return; setChatLoading(true); setError(''); setAiJob(null); setAiTest(null);
    try{ const s=await api.createChatSession(chatSnapshot.id); setChatSession(s); setFollowupMessages([]); setFollowupDraft(''); setAnswerDraft(''); setChoiceDraft(''); setDetailDraft(''); if(selected)loadAnalysisVersions(selected.area,selected.name,projectBase); }
    catch(e){setError(e.message);}finally{setChatLoading(false);}
  }

  async function newAnalysis(){
    if(view!=='chat' || !chatSnapshot?.id){ setView(projectKey?'chat':'home'); return; }
    await startChat();
  }

  const questions=chatSession?.state?.qualification?.questions||[];
  const currentIndex=Number(chatSession?.state?.currentQuestion||0);
  const currentQuestion=questions[currentIndex] || null;

  async function submitAnswer(){
    if(!chatSession||!currentQuestion)return;
    const value=currentQuestion.kind==='text'?answerDraft:choiceDraft;
    const hasValue=Array.isArray(value)?value.length>0:String(value||'').trim()!=='';
    const customComparison=currentQuestion.id==='comparisonPeriods'&&String(detailDraft||'').trim();
    if(currentQuestion.required && !hasValue && !customComparison) return;
    setChatLoading(true); setError('');
    try{
      const payload={questionId:currentQuestion.id,value};
      if(currentQuestion.id==='purpose') payload.detail=detailDraft;
      if(currentQuestion.id==='milestones') payload.highlight=detailDraft;
      if(currentQuestion.id==='comparisonPeriods') payload.custom=detailDraft;
      const next=await api.answerChat(chatSession.id,payload); setChatSession(next);
      setAnswerDraft(''); setChoiceDraft(''); setDetailDraft('');
    }catch(e){setError(e.message);}finally{setChatLoading(false);}
  }

  async function testAi(){ setTestingAi(true); setAiTest(null); try{setAiTest({ok:true,...await api.testAiProvider()});}catch(e){setAiTest({ok:false,error:e.message,details:e.details});}finally{setTestingAi(false);} }

  async function analyzeChat(){
    if(!chatSession)return; setError(''); setAiJob({status:'queued',progress:0,stage:'Preparando análise…'});
    try{
      const created=await api.analyzeChat(chatSession.id); setAiJob(created);
      watchJob(created,api.aiEventsUrl,api.getAiAnalysis,setAiJob,async()=>{ try{const latest=await api.getChatSession(chatSession.id);setChatSession(latest);await loadFollowupMessages(latest.id);}catch{} if(selected)await loadAnalysisVersions(selected.area,selected.name,projectBase); });
    }catch(e){setError(e.message);setAiJob(null);}
  }

  async function sendFollowup(){
    if(!chatSession||!followupDraft.trim()||followupLoading)return; const message=followupDraft.trim(); setFollowupDraft(''); setFollowupLoading(true); setError('');
    try{
      const out=await api.chatFollowup(chatSession.id,message);
      if(out.type==='new_version'&&out.session){setChatSession(out.session);setAiJob(null);setAiTest(null);setAnswerDraft('');setChoiceDraft('');setDetailDraft('');setFollowupMessages([]);}
      else await loadFollowupMessages(chatSession.id);
      if(selected)await loadAnalysisVersions(selected.area,selected.name,projectBase);
    }catch(e){setError(e.message);setFollowupDraft(message);}finally{setFollowupLoading(false);}
  }

  function Sidebar(){
    return <aside className="sidebar">
      <button className="brand-button" onClick={goHome}>
        <strong>TOOLS</strong><span>Análise de Cronograma</span>
      </button>
      <button className="new-analysis" onClick={newAnalysis}><Plus size={17}/><span>Nova análise</span></button>
      <div className="side-search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar projeto"/></div>
      <div className="side-section-label">Projetos por BU</div>
      <div className="bu-tree">
        {BU_ORDER.map(area=>{
          const meta=BU_META[area]; const items=(projectsByBu[area]||[]).filter(o=>!query.trim()||o.name.toLowerCase().includes(query.trim().toLowerCase()));
          const open=expandedBus[area];
          return <div className="bu-group" key={area}>
            <button className="bu-toggle" onClick={()=>setExpandedBus(s=>({...s,[area]:!s[area]}))}>
              <meta.Icon size={16}/><span>{meta.label}</span><small>{projectsByBu[area]?.length||0}</small><ChevronDown size={14} className={open?'open':''}/>
            </button>
            {open&&<div className="project-tree">{items.length?items.map(o=><button key={keyOf(o)} className={projectKey===keyOf(o)&&view==='chat'?'active':''} onClick={()=>openProject(o)}><span className="project-dot"></span><span>{o.name}</span></button>):<div className="tree-empty">Nenhum projeto</div>}</div>}
          </div>;
        })}
      </div>
      <div className="sidebar-bottom">
        <button className={view==='data'?'admin-link active':'admin-link'} onClick={()=>setView('data')}><Settings2 size={16}/><span><b>Dados</b><small>Administração das bases</small></span></button>
        <div className="side-status"><span className="dot"></span><div><b>Base em modo leitura</b><small>{health?.ai?.configured?'IA configurada':'IA não configurada'}</small></div></div>
      </div>
    </aside>;
  }

  function HomeView(){
    return <main className="landing">
      <div className="landing-inner">
        <div className="landing-mark"><Sparkles size={23}/></div>
        <span className="eyebrow">TOOLS · ANÁLISE DE CRONOGRAMA</span>
        <h1>Qual obra você quer analisar?</h1>
        <p>Escolha a unidade de negócio e abra o projeto. O chat carrega a base já criada, faz as perguntas de qualificação e gera o HTML padrão TOOLS.</p>
        <div className="landing-search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar projeto por nome ou sigla…"/></div>
        <div className="bu-cards">
          {BU_ORDER.map(area=>{const meta=BU_META[area]; return <button key={area} className={`bu-card ${homeBu===area?'active':''}`} onClick={()=>setHomeBu(homeBu===area?'':area)}><div className="bu-card-icon"><meta.Icon size={21}/></div><div><b>{meta.label}</b><span>{projectsByBu[area]?.length||0} projetos</span></div><ChevronLeft size={17} className="go"/></button>;})}
        </div>
        {(homeBu||query.trim())&&<section className="project-picker">
          <div className="picker-head"><div><b>{homeBu?BU_META[homeBu].label:'Resultados'}</b><span>{filtered.length} projeto(s)</span></div>{homeBu&&<button onClick={()=>setHomeBu('')}>Ver todas as BUs</button>}</div>
          <div className="project-cards">{filtered.length?filtered.map(o=><button className="project-card" key={keyOf(o)} onClick={()=>openProject(o)}><div className="project-card-icon"><Building2 size={18}/></div><div><b>{o.name}</b><span>{BU_META[o.area]?.label||o.area}</span></div><ChevronLeft size={16} className="go"/></button>):<div className="no-projects">Nenhum projeto encontrado.</div>}</div>
        </section>}
        <div className="landing-note"><ShieldCheck size={15}/><span>A conversa usa a base preservada do projeto e não altera os arquivos de origem.</span></div>
      </div>
    </main>;
  }

  function DataView(){
    const snap=dataSnapshot; const files=snap?.files||[]; const partial=files.filter(f=>['partial','failed'].includes(f.status)).length;
    const ocrCount=files.filter(f=>ocrLabel(f).text!=='OCR N/A').length;
    const corpusChars=files.reduce((sum,f)=>sum+Number(f.extraction?.corpusStats?.combinedCharacters||0),0);
    return <main className="admin-page">
      <div className="admin-head"><div><span className="eyebrow">ÁREA TÉCNICA · DADOS</span><h1>Criação e atualização das bases</h1><p>Uso administrativo. Cada obra possui duas bases independentes: <b>GO</b> e <b>GP</b>. Aqui a equipe cria os JSONs, executa OCR e mantém cada base que alimenta o chat.</p></div><ProjectSelector/></div>
      {warnings.length>0&&<div className="notice warn"><AlertCircle size={17}/><span>{warnings.join(' · ')}</span></div>}
      {!selected?<EmptyData/>:<>
        <section className="panel project-ingest">
          <div className="base-switch-row"><ProjectBaseSwitch value={projectBase} onChange={switchProjectBase} status={baseStatus?.bases}/></div>
          <div className="panel-head"><div><FolderSync size={20}/><div><span className="eyebrow">BASE {projectBase} · {PROJECT_BASES[projectBase].title}</span><h2>{selected.name}</h2><p>{snap?.folder?.path || expectedProjectPath(selected.area,selected.name,projectBase)}</p></div></div><div className="actions"><button className="btn secondary" onClick={()=>loadLatestSnapshot(projectKey,{base:projectBase})} disabled={loadingSnapshot}><RefreshCw size={15}/> Atualizar tela</button><button className="btn primary" onClick={()=>syncProject()} disabled={['queued','processing'].includes(extractionJob?.status)}>{['queued','processing'].includes(extractionJob?.status)?<LoaderCircle className="spin" size={16}/>:<FolderSync size={16}/>} Sincronizar base {projectBase}</button></div></div>
          {extractionJob&&<JobProgress job={extractionJob}/>} 
        </section>
        <section className="panel schedule-panel">
          <div className="schedule-head"><div><Clock3 size={19}/><div><span className="eyebrow">ATUALIZAÇÃO AUTOMÁTICA · BASE {projectBase}</span><h2>Janelas de sincronização</h2><p>Na primeira execução a base é criada por completo. Depois, cada janela apenas inventaria a pasta e processa arquivos novos, alterados ou removidos.</p></div></div><label className="schedule-toggle"><input type="checkbox" checked={scheduleDraft.enabled} onChange={e=>setScheduleDraft(x=>({...x,enabled:e.target.checked}))}/><span>{scheduleDraft.enabled?'Ativa':'Desativada'}</span></label></div>
          <div className="schedule-grid">
            <div className="schedule-times"><label>Horários de atualização <small>Horário de Brasília</small></label><div className="time-list">{scheduleDraft.times.map((time,index)=><div className="time-item" key={`${time}-${index}`}><input type="time" value={time} onChange={e=>setScheduleDraft(x=>({...x,times:x.times.map((v,i)=>i===index?e.target.value:v)}))}/><button title="Remover horário" onClick={()=>setScheduleDraft(x=>({...x,times:x.times.filter((_,i)=>i!==index)}))} disabled={scheduleDraft.times.length<=1}><Trash2 size={14}/></button></div>)}</div><button className="add-time" onClick={()=>setScheduleDraft(x=>({...x,times:[...x.times,'18:00']}))}><Plus size={14}/> Adicionar horário</button></div>
            <div className="schedule-options"><label className="check-line"><input type="checkbox" checked={scheduleDraft.onAnalysisRefresh} onChange={e=>setScheduleDraft(x=>({...x,onAnalysisRefresh:e.target.checked}))}/><span><b>Atualizar antes da análise</b><small>Ao clicar em Gerar análise + HTML, confere a pasta e processa somente o delta antes de chamar a IA.</small></span></label><div className="schedule-last"><span>Última execução automática</span><b>{syncSchedule?.lastCompletedAt?new Date(syncSchedule.lastCompletedAt).toLocaleString('pt-BR'):'Ainda não executada'}</b>{syncSchedule?.lastStatus&&<StatusBadge status={syncSchedule.lastStatus}/>} {syncSchedule?.lastError&&<small>{syncSchedule.lastError}</small>}</div></div>
          </div>
          <div className="schedule-actions"><span>{scheduleDraft.enabled?`${scheduleDraft.times.length} janela(s) configurada(s)`: 'O agendador não roda enquanto estiver desativado.'}</span><button className="btn primary" onClick={saveSyncSchedule} disabled={scheduleLoading}>{scheduleLoading?<LoaderCircle className="spin" size={15}/>:<Save size={15}/>} Salvar janelas</button></div>
        </section>
        {snap?<>
          <div className="metric-grid"><Metric label="Arquivos" value={snap.totals?.files||files.length} sub={`na base ${projectBase}`}/><Metric label="JSONs disponíveis" value={snap.totals?.artifacts||files.filter(f=>f.artifactKey).length} sub="persistidos no SQLite"/><Metric label="Arquivos com OCR" value={ocrCount} sub="PDF/imagem/mídia elegível"/><Metric label="Corpus mestre" value={num(corpusChars)} sub="caracteres nativos + OCR"/><Metric label="Limitações" value={partial} sub={partial?'podem ser reprocessadas':'cobertura técnica sem falhas'}/></div>
          <section className="panel project-json"><div><FileJson size={20}/><span><b>JSON completo da base {projectBase}</b><small>Montado por streaming a partir dos artefatos persistidos. Inclui texto nativo, OCR, estrutura machine-readable, cobertura e rastreabilidade.</small></span></div><div className="actions"><a className="btn secondary" href={api.projectJsonUrl(snap.id)}><Download size={15}/> JSON completo</a><a className="btn secondary" href={api.jsonPackageUrl(snap.id)}><Download size={15}/> Pacote JSONs</a>{partial>0&&<button className="btn secondary" onClick={()=>syncProject({retryPartial:true})}><RefreshCw size={15}/> Reprocessar limitações</button>}</div></section>
          <section className="panel files-panel"><div className="panel-title"><div><TableProperties size={18}/><div><span className="eyebrow">ARQUIVOS DA BASE</span><h2>{files.length} documentos</h2></div></div><span>cada linha possui seu JSON e OCR quando aplicável</span></div><div className="file-table-head"><span>Documento</span><span>Leitura</span><span>OCR</span><span>Status</span><span></span></div><div className="file-list">{files.map((f,i)=>{const o=ocrLabel(f);return <div className="file-row" key={`${f.relativePath}-${i}`}><div><FileJson size={17}/><span><b>{f.name}</b><small>{f.relativePath}</small></span></div><span>{String(f.extraction?.kind||f.ext||'arquivo').toUpperCase()}</span><Badge tone={o.tone}>{o.text}</Badge><StatusBadge status={f.status}/><div className="row-actions"><button title="Visualizar JSON" onClick={()=>previewArtifact(i)}><Eye size={15}/></button>{f.artifactKey&&<a title="Baixar JSON" href={api.artifactExportUrl(snap.id,i,'json')}><Download size={15}/></a>}</div></div>})}</div></section>
          {(previewLoading||artifactPreview)&&<section className="panel preview-panel"><div className="panel-title"><div><Eye size={18}/><div><span className="eyebrow">PRÉVIA DO JSON</span><h2>{previewLoading?'Carregando…':artifactPreview?.file?.name}</h2></div></div><button className="icon-btn" onClick={()=>setArtifactPreview(null)}><XCircle size={18}/></button></div>{artifactPreview&&<div className="preview-grid"><PreviewBlock title="Texto nativo" value={artifactPreview.artifact?.nativeTextPreview}/><PreviewBlock title="OCR" value={artifactPreview.artifact?.ocrTextPreview}/><PreviewBlock title="Machine-readable" value={artifactPreview.artifact?.machinePreview}/></div>}</section>}
        </>:<section className="panel empty-state"><Database size={34}/><h2>Base {projectBase} ainda não está no banco</h2><p>Clique em <b>Sincronizar base {projectBase}</b>. GO e GP mantêm inventário, histórico e JSONs independentes; arquivos idênticos ainda podem reaproveitar artefatos por hash.</p></section>}
      </>}
    </main>;
  }

  function ProjectSelector({label='Projeto'}){ return <div className="project-selector"><label>{label}</label><div className="select-wrap"><Building2 size={16}/><select value={projectKey} onChange={e=>{setProjectKey(e.target.value);setProjectBase('GO');}}><option value="">Selecione um projeto…</option>{BU_ORDER.map(area=><optgroup key={area} label={BU_META[area].label}>{projectsByBu[area]?.map(o=><option key={keyOf(o)} value={keyOf(o)}>{o.name}</option>)}</optgroup>)}</select><ChevronDown size={15}/></div></div>; }
  function EmptyData(){return <section className="panel empty-state"><Building2 size={34}/><h2>Selecione um projeto</h2><p>Escolha uma obra e depois selecione GO ou GP para visualizar ou sincronizar a base documental correspondente.</p></section>;}

  function ChatView(){
    const q=chatSession?.state?.qualification; const answers=chatSession?.state?.answers||{}; const ready=chatSession?.status==='ready';
    const meta=selected?BU_META[selected.area]:null;
    return <main className="chat-screen">
      <header className="chat-project-bar">
        <div className="project-breadcrumb"><button onClick={goHome}><ChevronLeft size={17}/></button><div><span>{meta?.label||'Projeto'}</span><h1>{selected?.name||'Selecione um projeto'}</h1></div></div>
        <div className="project-bar-actions"><ProjectBaseSwitch value={projectBase} onChange={switchProjectBase} status={baseStatus?.bases} compact/>{chatSnapshot&&<><Badge tone={chatSnapshot.status==='completed'?'ok':'muted'}>{chatSnapshot.totals?.artifacts||0} JSONs</Badge><Badge tone="muted">{analysisVersions.length} análise(s)</Badge></>}<button className="icon-text-btn" onClick={newAnalysis} disabled={!chatSnapshot}><Plus size={15}/> Nova análise</button></div>
      </header>
      <section className="chat-body">
        {!selected?<div className="chat-empty"><div className="landing-mark"><MessageSquareText size={22}/></div><h2>Selecione uma obra</h2><p>Use a barra lateral para entrar em Residencial, Corporativo ou Predial e abrir um projeto.</p></div>:loadingSnapshot?<div className="chat-empty"><LoaderCircle className="spin" size={24}/><h2>Carregando base do projeto…</h2></div>:!chatSnapshot?<div className="chat-empty"><Database size={26}/><h2>Base ainda não criada</h2><p>A base selecionada ainda não foi criada. A equipe precisa sincronizar esta fonte na área Dados antes de disponibilizá-la para análise.</p></div>:<>
          <div className="messages">
            {!chatSession?<><ChatWelcome text={`A base ${projectBase} de ${selected.name} está pronta. Vou confirmar a periodicidade e os períodos que você quer comparar. Se já existir resultado anterior, a nova versão parte dele e atualiza somente o necessário.`}/>{analysisVersions.length>0&&<AnalysisHistory versions={analysisVersions}/>}</>:<>
              <AssistantBubble><b>Olá. Já carreguei a base {chatSession.projectBase||projectBase} de {chatSession.obra}.</b><p>Encontrei {q?.detected?.files||chatSnapshot.totals?.files||0} arquivos e {q?.detected?.versions?.length||0} versão(ões) nativa(s) para confronto.</p>{q?.detected?.currentSchedule?.name&&<p>Cronograma vigente: <b>{q.detected.currentSchedule.name}</b>{q.detected.statusDate?` · status ${String(q.detected.statusDate).slice(0,10)}`:''}{q.detected.plannedFinish?` · término ${String(q.detected.plannedFinish).slice(0,10)}`:''}.</p>}<p className="muted-copy">Antes de gerar o resultado, vou confirmar periodicidade, períodos de comparação e as demais perguntas do método TOOLS. Se já houver uma análise anterior, a nova versão partirá dela e atualizará somente o que mudou.</p></AssistantBubble>{analysisVersions.length>0&&<AnalysisHistory versions={analysisVersions}/>}
              {questions.slice(0,Math.min(currentIndex,questions.length)).map(question=><React.Fragment key={question.id}><AssistantBubble compact><b>{question.title}</b></AssistantBubble><UserBubble>{formatAnswer(question,answers,q)}</UserBubble></React.Fragment>)}
              {currentQuestion&&chatSession.status==='qualification'&&<AssistantBubble><b>{currentQuestion.title}</b><p>{currentQuestion.helper}</p>{currentQuestion.id==='milestones'&&<MilestoneProposal milestones={q?.proposedMilestones||[]}/>}</AssistantBubble>}
              {ready&&<AssistantBubble><b>Perfeito. Já tenho o necessário para esta versão.</b><p>Antes da IA, o sistema verifica a pasta <b>{projectBase}</b> e processa somente arquivos novos, modificados, renomeados ou excluídos.</p><p>{q?.analysisMode==='update'?<>Esta análise será uma <b>atualização incremental</b>: a IA parte do último resultado, carrega somente os períodos que você escolheu e aplica o delta encontrado. O restante do relatório anterior é preservado.</>:<>Como esta é a primeira versão, a IA usa somente os períodos escolhidos e o contexto necessário para montar o resultado base.</>}</p>{aiTest&&<div className={`inline-test ${aiTest.ok?'ok':'bad'}`}>{aiTest.ok?<CheckCircle2 size={15}/>:<XCircle size={15}/>} {aiTest.ok?`IA disponível · ${aiTest.probe?.model||aiTest.model}`:aiTest.error}</div>}</AssistantBubble>}
              {aiJob&&<AssistantBubble><JobProgress job={aiJob} compact/>{aiJob.error&&<div className="notice bad"><XCircle size={16}/><div><b>{aiJob.result?.renderFailed?'Falha HTML':'Falha IA'}</b><span>{aiJob.error}</span>{aiJob.errorDetails&&<pre>{JSON.stringify(aiJob.errorDetails,null,2)}</pre>}</div></div>}</AssistantBubble>}
              {aiJob?.result?.html&&<AssistantBubble><b>Análise concluída.</b><p>O HTML foi gerado pelo template oficial da skill a partir do JSON de resultado preparado.</p><div className="result-actions"><a className="btn primary" target="_blank" rel="noreferrer" href={api.aiHtmlViewUrl(aiJob.result.analysisId)}><Eye size={15}/> Abrir HTML</a><a className="btn secondary" href={api.aiHtmlDownloadUrl(aiJob.result.analysisId)}><Download size={15}/> Baixar HTML</a><a className="btn secondary" href={api.aiOutputPackageUrl(aiJob.result.analysisId)}><Download size={15}/> Pacote completo</a></div>{aiJob.result.preparedResult?.executiveSummary?.length>0&&<div className="exec-summary"><b>Resumo executivo</b><ol>{aiJob.result.preparedResult.executiveSummary.map((x,i)=><li key={i}>{x}</li>)}</ol></div>}<iframe title="Prévia HTML TOOLS" className="html-frame" src={api.aiHtmlViewUrl(aiJob.result.analysisId)}/></AssistantBubble>}{followupMessages.map(m=>m.role==='user'?<UserBubble key={m.id}>{m.content}</UserBubble>:<AssistantBubble key={m.id}><p>{m.content}</p>{m.metadata?.targetedStats&&<small className="targeted-stats">Consulta direcionada: {m.metadata.targetedStats.tasks||0} tarefa(s) · {m.metadata.targetedStats.versionChanges||0} mudança(s) · {m.metadata.targetedStats.documents||0} documento(s)</small>}</AssistantBubble>)}
            </>}
          </div>
          <div className="composer-dock">
            {!chatSession?<div className="start-card"><button className="start-chat-btn" onClick={startChat} disabled={chatLoading}>{chatLoading?<LoaderCircle className="spin" size={17}/>:<MessageSquareText size={17}/>} Começar análise de {selected.name}</button><span>A base será usada somente para leitura e análise.</span></div>:currentQuestion&&chatSession.status==='qualification'?<ChatComposer question={currentQuestion} value={currentQuestion.kind==='text'?answerDraft:choiceDraft} onValue={v=>currentQuestion.kind==='text'?setAnswerDraft(v):setChoiceDraft(v)} detail={detailDraft} onDetail={setDetailDraft} disabled={chatLoading} onSubmit={submitAnswer}/>:ready?<div className="ready-composer"><button className="btn secondary" onClick={testAi} disabled={testingAi}>{testingAi?<LoaderCircle className="spin" size={15}/>:<ShieldCheck size={15}/>} Testar IA</button><button className="btn primary generate" onClick={analyzeChat} disabled={!health?.ai?.configured||['queued','processing'].includes(aiJob?.status)}><Sparkles size={16}/> Gerar análise + HTML</button></div>:aiJob?.status==='processing'||aiJob?.status==='queued'?<div className="composer-note"><LoaderCircle className="spin" size={16}/> Analisando o projeto…</div>:aiJob?.result?.html?<FollowupComposer value={followupDraft} onValue={setFollowupDraft} onSubmit={sendFollowup} loading={followupLoading}/>:<div className="composer-note">A conversa deste projeto está concluída.</div>}
            <div className="composer-disclaimer">A primeira análise cria a base de resultado. Nas próximas versões e dúvidas, o sistema reutiliza o último resultado e consulta somente períodos, arquivos e evidências relacionados ao pedido atual.</div>
          </div>
        </>}
      </section>
    </main>;
  }

  return <div className="app-shell"><Sidebar/><div className="workspace">{error&&<div className="global-error"><XCircle size={17}/><span>{error}</span><button onClick={()=>setError('')}>×</button></div>}{view==='home'?<HomeView/>:view==='data'?<DataView/>:<ChatView/>}</div></div>;
}

function ProjectBaseSwitch({value,onChange,status={},compact=false}){
  return <div className={`project-base-switch ${compact?'compact':''}`} role="group" aria-label="Base do projeto">
    {['GO','GP'].map(base=>{const st=status?.[base]; const ready=Boolean(st?.latestSync); return <button key={base} className={value===base?'active':''} onClick={()=>onChange(base)} title={PROJECT_BASES[base].title}><span>{base}</span>{!compact&&<small>{PROJECT_BASES[base].title}</small>}<i className={ready?'ready':'empty'}></i></button>;})}
  </div>;
}

function Metric({label,value,sub}){return <div className="metric"><span>{label}</span><b>{value}</b><small>{sub}</small></div>}
function PreviewBlock({title,value}){return <div><b>{title}</b><pre>{value||'—'}</pre></div>}
function JobProgress({job,compact=false}){return <div className={`job-progress ${compact?'compact':''}`}><div className="job-top"><Activity size={16}/><b>{job.stage||'Processando'}</b><StatusBadge status={job.status}/></div><div className="progress"><span style={{width:`${job.progress||0}%`}}></span></div><small>{job.progress||0}%{job.totalFiles?` · ${job.processedFiles||0}/${job.totalFiles} arquivos`:''}</small></div>}
function ChatWelcome({text}){return <div className="chat-welcome"><div className="bot-icon"><Bot size={23}/></div><h2>Vamos analisar este projeto</h2><p>{text}</p></div>}
function AssistantBubble({children,compact=false}){return <div className={`bubble-row assistant ${compact?'compact':''}`}><div className="avatar"><Bot size={16}/></div><div className="bubble">{children}</div></div>}
function UserBubble({children}){return <div className="bubble-row user"><div className="bubble">{children}</div></div>}
function MilestoneProposal({milestones}){return <div className="milestones"><span>Marcos detectados</span>{milestones.length?<ol>{milestones.map((m,i)=><li key={`${m.name}-${i}`}>{m.name}{m.finish?<small>{String(m.finish).slice(0,10)}</small>:null}{m.critical?<Badge tone="bad">crítico</Badge>:null}</li>)}</ol>:<p>Nenhum marco explícito foi identificado; a IA registrará a limitação.</p>}</div>}
function AnalysisHistory({versions=[]}){
  return <AssistantBubble><div className="analysis-history"><div className="history-title"><Clock3 size={15}/><b>Histórico de análises</b><span>{versions.length} versão(ões)</span></div><div className="history-list">{versions.slice(0,8).map(v=><div className="history-item" key={v.id}><div><b>V{v.versionNo}</b><span>{v.periodicity||'periodicidade não informada'}</span></div><small>{(v.comparison||[]).map(x=>String(x).split(/[\\/]/).pop()).join(' × ')||'sem confronto registrado'} · {v.completedAt?new Date(v.completedAt).toLocaleString('pt-BR'):v.status}</small>{v.analysisId&&<a target="_blank" rel="noreferrer" href={api.aiHtmlViewUrl(v.analysisId)}>Abrir</a>}</div>)}</div><p className="muted-copy">Cada nova análise vira uma versão independente. Atualizações partem da versão anterior, mas usam somente os períodos escolhidos e o delta documental.</p></div></AssistantBubble>;
}
function formatAnswer(question,answers,q){
  if(question.id==='stratification'){ const opt=q?.stratificationOptions?.find(x=>x.id===answers.stratification); return opt?`${opt.id} — ${opt.label}`:answers.stratification||'—'; }
  if(question.id==='purpose') return answers.purposeDetail?`${answers.purpose} — ${answers.purposeDetail}`:answers.purpose||'—';
  if(question.id==='milestones') return answers.milestoneHighlight?`${answers.milestones} — destacar: ${answers.milestoneHighlight}`:answers.milestones||'—';
  if(question.id==='comparisonPeriods'){
    const values=Array.isArray(answers.comparisonPeriods)?answers.comparisonPeriods:[];
    const labels=values.map(v=>question.options?.find(o=>(typeof o==='string'?o:o.value)===v)).map(o=>typeof o==='string'?o:o?.label).filter(Boolean);
    return [labels.join(' × '),answers.comparisonCustom?`customizado: ${answers.comparisonCustom}`:''].filter(Boolean).join(' · ')||'—';
  }
  return answers[question.id]||'não sei';
}
function ChatComposer({question,value,onValue,detail,onDetail,onSubmit,disabled}){
  const multi=question.kind==='multi_choice_text';
  const currentMulti=Array.isArray(value)?value:[];
  const showDetail=(question.id==='purpose'&&value==='Outro') || (question.id==='milestones'&&value==='Ajustar / adicionar / destacar um marco') || multi;
  const multiValid=!multi || currentMulti.length>=Number(question.minSelections||2) || String(detail||'').trim();
  const detailRequired=((question.id==='purpose'&&value==='Outro') || (question.id==='milestones'&&value==='Ajustar / adicionar / destacar um marco')) && !String(detail||'').trim();
  const hasValue=multi?multiValid:String(value||'').trim();
  const cannotSend=disabled||(question.required&&!hasValue)||detailRequired;
  const enter=e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); if(!cannotSend)onSubmit(); } };
  const choose=val=>{ if(!multi){onValue(val);return;} const next=currentMulti.includes(val)?currentMulti.filter(x=>x!==val):[...currentMulti,val]; onValue(next); };
  return <div className="chat-composer">
    {question.kind!=='text'&&<div className={`quick-replies ${multi?'multi':''}`}>{(question.options||[]).map(o=>{const val=typeof o==='string'?o:o.value; const label=typeof o==='string'?o:o.label; const selected=multi?currentMulti.includes(val):value===val; return <button key={val} className={selected?'selected':''} onClick={()=>choose(val)}>{multi&&<span className="checkmark">{selected?'✓':''}</span>}{label}</button>})}</div>}
    <div className="composer-box">
      {question.kind==='text'?<textarea autoFocus rows={1} placeholder={question.placeholder||'Digite sua resposta…'} value={value} onChange={e=>onValue(e.target.value)} onKeyDown={enter}/>:<div className="selected-answer">{multi?(currentMulti.length?`${currentMulti.length} período(s) selecionado(s)`:String(detail||'').trim()?'Comparação personalizada informada':'Selecione os períodos acima'):value||'Escolha uma das opções acima'}</div>}
      <button className="send-circle" onClick={onSubmit} disabled={cannotSend}>{disabled?<LoaderCircle className="spin" size={16}/>:<Send size={16}/>}</button>
    </div>
    {showDetail&&<textarea className="detail-box" rows={2} placeholder={multi?'Opcional: descreva um confronto específico, ex.: Semana 10 × Semana 18':question.id==='purpose'?'Descreva a finalidade…':'Qual marco ou tema deve ser destacado?'} value={detail} onChange={e=>onDetail(e.target.value)} onKeyDown={enter}/>} 
  </div>;
}
function FollowupComposer({value,onValue,onSubmit,loading}){
  const enter=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(value.trim()&&!loading)onSubmit();}};
  return <div className="followup-composer"><div className="composer-box"><textarea rows={1} value={value} onChange={e=>onValue(e.target.value)} onKeyDown={enter} placeholder="Pergunte sobre o resultado, tire uma dúvida ou peça uma nova versão…"/><button className="send-circle" onClick={onSubmit} disabled={loading||!value.trim()}>{loading?<LoaderCircle className="spin" size={16}/>:<Send size={16}/>}</button></div><small>Para dúvidas, a IA consulta somente o último resultado e evidências ligadas à pergunta. Se você pedir nova versão/atualização, o sistema abre um novo fluxo de periodicidade e comparação.</small></div>;
}

export default App;
