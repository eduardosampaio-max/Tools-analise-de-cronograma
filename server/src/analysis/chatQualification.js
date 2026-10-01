function arr(v){ return Array.isArray(v)?v:(v==null?[]:[v]); }
function s(v=''){ return String(v ?? '').trim(); }
function n(v){ const x=Number(v); return Number.isFinite(x)?x:null; }
function normalize(v=''){ return s(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9ºª]+/g,' ').replace(/\s+/g,' ').trim(); }
function taskLevel(t){ return n(t?.OutlineLevel) ?? (s(t?.WBS).split('.').filter(Boolean).length || null); }
function isSummary(t){ return t?.Summary===true || t?.Summary===1 || String(t?.Summary).toLowerCase()==='true'; }
function labelForNames(names=[]){
  const joined=normalize(names.join(' '));
  if(/pavimento|andar/.test(joined)) return 'Por pavimento'; if(/torre/.test(joined)) return 'Por torre'; if(/bloco/.test(joined)) return 'Por bloco';
  if(/casa|quadra/.test(joined)) return 'Por casa / quadra'; if(/fachada/.test(joined)) return 'Por fachada / trecho'; if(/setor|area/.test(joined)) return 'Por setor / área';
  return 'Pelo nível da EAP';
}
function versionLabel(v,i=0){
  const name=s(v?.source?.name || v?.source?.relativePath || '');
  const sem=name.match(/sem(?:ana)?\s*[-_ ]?(\d+)/i); if(sem) return `Semana ${sem[1]}`;
  const rev=name.match(/rev(?:is[aã]o)?\s*[-_ ]?(\d+)/i); if(rev) return `Rev ${rev[1]}`;
  const d=s(v?.statusDate || v?.projectInfo?.StatusDate).slice(0,10); return d ? `Status ${d}` : `Versão ${i+1}`;
}
function versionValue(v,i=0){ return s(v?.source?.relativePath || v?.source?.name || `version_${i+1}`); }

export function buildQualification(preparation,{previousVersion=null}={}){
  const context=preparation?.canonicalContext || {}; const current=context?.schedule?.current || {}; const tasks=arr(current.tasks);
  const summaries=tasks.filter(isSummary); const levels=new Map();
  for(const t of summaries){ const level=taskLevel(t); if(level==null||level<1||level>8)continue; if(!levels.has(level))levels.set(level,[]); levels.get(level).push(t); }
  const levelCandidates=[...levels.entries()].map(([level,items])=>({level,items,count:items.length,names:items.map(x=>s(x.Name)).filter(Boolean)})).filter(x=>x.count>=2&&x.count<=40).sort((a,b)=>{const af=(a.count>=3&&a.count<=15)?0:1,bf=(b.count>=3&&b.count<=15)?0:1;return af-bf||a.level-b.level;});
  const primary=levelCandidates[0]||{level:3,count:0,names:[]}, secondary=levelCandidates.find(x=>x.level!==primary.level)||{level:Math.max(2,primary.level-1),count:0,names:[]};
  const option=(x,id)=>({id,label:`${labelForNames(x.names)} (nível ${x.level})`,level:x.level,reason:x.names.length?`Exemplos detectados: ${x.names.slice(0,5).join(' · ')}`:'Alternativa baseada na estrutura da EAP.',examples:x.names.slice(0,8)});
  const stratificationOptions=[option(primary,'A'),option(secondary,'B')];

  const metrics=context?.schedule?.metrics || current?.metrics || {}; const milestonePool=arr(metrics.milestones);
  const scored=milestonePool.map(m=>{const name=normalize(m.name||m.Name);let score=0;if(m.critical||m.Critical)score+=12;if((n(m.pct)??n(m.PercentComplete)??0)<100)score+=5;if(/entrega|termino|conclus|teste|forro|carpete|mobili|fachada|elevador|vistoria|ligacao|limpeza|startup/.test(name))score+=5;return {...m,_score:score};}).sort((a,b)=>b._score-a._score||String(a.finish||a.Finish||'').localeCompare(String(b.finish||b.Finish||'')));
  const seen=new Set(), proposedMilestones=[]; for(const m of scored){const name=s(m.name||m.Name),key=normalize(name);if(!key||seen.has(key))continue;seen.add(key);proposedMilestones.push({name,finish:m.finish||m.Finish||null,critical:Boolean(m.critical??m.Critical),taskId:m.id??m.ID??null,wbs:m.wbs??m.WBS??null});if(proposedMilestones.length>=15)break;}

  const available=arr(context?.schedule?.availableVersions).length?arr(context.schedule.availableVersions):arr(context.selectedScheduleVersions);
  const versionOptions=available.map((v,i)=>({value:versionValue(v,i),label:versionLabel(v,i),description:[s(v?.statusDate||v?.projectInfo?.StatusDate).slice(0,10),s(v?.source?.name)].filter(Boolean).join(' · '),source:v.source,statusDate:v?.statusDate||v?.projectInfo?.StatusDate||null}));
  const selectedDefaults=versionOptions.slice(-Math.min(3,versionOptions.length)).map(x=>x.value);
  const versions=arr(context.selectedScheduleVersions); const currentVersion=versions[versions.length-1]||null;
  const detected={currentSchedule:currentVersion?.source||current?.source||null,statusDate:metrics.statusDate||current?.projectInfo?.StatusDate||null,plannedFinish:metrics.finish||current?.projectInfo?.FinishDate||null,baselineFinish:metrics.baselineFinish||null,versions:versions.map(v=>({name:v?.source?.name,path:v?.source?.relativePath,statusDate:v?.projectInfo?.StatusDate||null,taskCount:v?.taskCount||0})),availableVersions:versionOptions,projectBase:context?.snapshot?.projectBase||context?.snapshot?.folder?.projectBase||'GO',files:Number(context?.snapshot?.totals?.files||0),artifacts:Number(context?.snapshot?.totals?.artifacts||0),previousAnalysis:previousVersion?{id:previousVersion.id,versionNo:previousVersion.versionNo,analysisId:previousVersion.analysisId,periodicity:previousVersion.periodicity,comparison:previousVersion.comparison,completedAt:previousVersion.completedAt}:null};

  const questions=[
    {id:'periodicity',kind:'choice',required:true,title:'Qual será a periodicidade desta análise?',helper:'Essa informação fica registrada na versão e orienta o confronto dos períodos.',options:['Semanal','Quinzenal','Mensal']},
  ];
  if(versionOptions.length>=2 || previousVersion){ questions.push({id:'comparisonPeriods',kind:'multi_choice_text',required:true,title:previousVersion?'Esta é uma atualização. Com quais períodos você quer comparar?':'Quais períodos/versões você quer confrontar nesta análise?',helper:previousVersion?'Selecione exatamente as versões que devem entrar na nova análise. Ex.: Semanas 15, 16 e 17 ou Semana 10 × Semana 18. O sistema não relerá versões fora desta seleção.':'Selecione duas ou mais versões. Você pode combinar períodos distantes; o sistema usará somente as versões escolhidas.',options:versionOptions,defaultValues:selectedDefaults,minSelections:2,allowCustom:true}); }
  questions.push(
    {id:'contractFinish',kind:'text',required:true,title:'Qual é o prazo contratual de término?',helper:'Se não souber, responda “não sei”. A análise seguirá registrando o prazo como “a confirmar”.',placeholder:'Ex.: 20/11/2026 ou não sei'},
    {id:'purpose',kind:'choice_text',required:true,title:'Para que você vai usar esta análise?',helper:'Isso calibra a leitura executiva e as perguntas finais.',options:['Reunião com o cliente','Reunião com a construtora','Reunião interna / diretoria','Outro']},
    {id:'stratification',kind:'choice',required:true,title:'Como quer enxergar as entregas?',helper:'O sistema detectou duas opções na EAP. A opção A é a recomendação inicial.',options:stratificationOptions.map(x=>({value:x.id,label:x.label,description:x.reason}))},
    {id:'milestones',kind:'confirm_text',required:true,title:'Os marcos propostos estão adequados?',helper:'Você pode confirmar a lista ou informar um marco/tema que precisa obrigatoriamente ser destacado.',options:['Confirmar marcos propostos','Ajustar / adicionar / destacar um marco']},
  );
  return {detected,stratificationOptions,proposedMilestones,questions,analysisMode:previousVersion?'update':'initial',previousVersion:detected.previousAnalysis};
}

function hasAnswer(v){ return Array.isArray(v)?v.filter(Boolean).length>0:Boolean(s(v)); }
export function qualificationComplete(state={}){ const a=state.answers||{}, questions=state?.qualification?.questions||[]; return questions.filter(q=>q.required).every(q=>{ if(q.id==='comparisonPeriods') return arr(a.comparisonPeriods).length>=Number(q.minSelections||2) || Boolean(s(a.comparisonCustom)); return hasAnswer(a[q.id]); }); }
export function qualificationForAi(session){
  const q=session?.state?.qualification||{},a=session?.state?.answers||{}; const selected=q.stratificationOptions?.find(x=>x.id===a.stratification)||q.stratificationOptions?.[0]||null;
  return {periodicity:s(a.periodicity),comparisonPeriods:arr(a.comparisonPeriods).map(s).filter(Boolean),comparisonCustom:s(a.comparisonCustom)||null,userRequest:s(session?.state?.requestedFromFollowup)||null,contractFinish:s(a.contractFinish)||'a confirmar',purpose:s(a.purpose),purposeDetail:s(a.purposeDetail)||null,stratification:{selected,answer:a.stratification||null},milestones:{confirmed:true,proposed:q.proposedMilestones||[],highlight:s(a.milestoneHighlight)||null},analysisMode:q.analysisMode||'initial',previousVersion:q.previousVersion||null,instruction:'Estas respostas foram dadas pelo usuário antes da análise final. Respeite exatamente a periodicidade, os períodos escolhidos e, quando houver, a solicitação explícita que originou a nova versão; não inclua versões fora da seleção.'};
}
