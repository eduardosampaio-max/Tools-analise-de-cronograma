import { config } from '../config.js';
import { parseLooseJson } from '../utils/json.js';
import { loadBlob } from '../extraction/snapshotStore.js';
import { loadArtifactFromDatabase } from '../db/snapshotRepository.js';
import { packageSystemPrompt, validatePreparedResult, packageProfile } from '../package/cronogramaPackage.js';

const INTERNAL_SCHEMA = `{
  "document_role": "o que este arquivo representa dentro do cronograma",
  "facts": ["fatos concretos relevantes para o prompt, preservando datas, valores, IDs e percentuais"],
  "dates": ["datas e respectivos significados"],
  "schedule_evidence": ["evidências sobre tarefas, baseline, avanço, caminho crítico, marcos, vínculos, restrições e reprogramações"],
  "crosscheck_keys": ["informações que devem ser comparadas com outros arquivos"],
  "warnings": ["inconsistências, limitações, ambiguidades ou pontos não confirmados"],
  "coverage": "alta|media|baixa"
}`;

let modelCatalogCache = { at:0, data:null };

function clip(value, max=2500) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0,max)}…` : text;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function estimatedTokensFromText(text='') { return Math.ceil(String(text).length / Math.max(2.2, Number(config.aiCharsPerTokenEstimate || 3.2))); }
function estimateMessageTokens(messages=[]) {
  return messages.reduce((sum,m)=>{
    const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
    return sum + estimatedTokensFromText(content) + 8;
  },0);
}

function providerMetadata(body={}) {
  const error = body?.error || {};
  const meta = error?.metadata || {};
  let raw = meta?.raw ?? meta?.error ?? meta?.body ?? null;
  if (raw && typeof raw !== 'string') raw = JSON.stringify(raw);
  return {
    message:error?.message || null,
    code:error?.code ?? null,
    provider:meta?.provider_name || meta?.provider || body?.provider || null,
    raw:raw ? clip(raw,5000) : null,
    requestId:body?.id || meta?.request_id || null,
  };
}

function errorCategory({ status, code, message='', raw='' }={}) {
  const text=`${message} ${raw}`.toLowerCase();
  if (status === 401 || /unauthor|api key|authentication/.test(text)) return 'authentication';
  if (status === 402 || /credit|balance|payment|insufficient/.test(text)) return 'credits';
  if (/context|token.*limit|too many tokens|maximum context|prompt.*long|input.*long|exceeds.*maximum.*tokens|max(?:imum)?.*tokens.*allowed/.test(text)) return 'context_length';
  if (/response_format|structured|json mode|json_object|parameter.*support|unsupported.*parameter/.test(text)) return 'structured_output';
  if (status === 429 || /rate limit|too many requests/.test(text)) return 'rate_limit';
  if ([408,425,500,502,503,504].includes(Number(status)) || /provider returned error|upstream|timeout|temporar|unavailable|overloaded/.test(text)) return 'provider_transient';
  if (Number(code) === 502) return 'provider_transient';
  return 'provider_error';
}

function makeOpenRouterError({ response, body, model, requestTokensEstimate, requestVariant }) {
  const meta=providerMetadata(body);
  const category=errorCategory({status:response?.status,code:meta.code,message:meta.message,raw:meta.raw});
  const parts=[meta.message || `OpenRouter HTTP ${response?.status || 'N/D'}`];
  if (meta.provider) parts.push(`provider=${meta.provider}`);
  if (meta.raw && meta.raw !== meta.message) parts.push(`detalhe=${meta.raw}`);
  const error=new Error(parts.join(' · '));
  error.name='OpenRouterRequestError';
  error.details={
    category,
    httpStatus:response?.status || null,
    code:meta.code,
    provider:meta.provider,
    raw:meta.raw,
    requestId:meta.requestId,
    model,
    requestVariant,
    estimatedInputTokens:requestTokensEstimate || null,
  };
  return error;
}

async function modelCatalog() {
  const now=Date.now();
  if (modelCatalogCache.data && now-modelCatalogCache.at < 15*60*1000) return modelCatalogCache.data;
  try {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    const response=await fetch(`${config.openRouter.baseUrl}/models`,{
      headers: config.openRouter.apiKey ? {Authorization:`Bearer ${config.openRouter.apiKey}`} : {},
      signal:controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body=await response.json();
    const data=Array.isArray(body?.data) ? body.data : [];
    modelCatalogCache={at:now,data};
    return data;
  } catch { return null; }
}

async function modelInfo(model) {
  const catalog=await modelCatalog();
  if (!catalog) return null;
  return catalog.find(x=>x.id===model) || null;
}

async function assertContextFits(messages, model) {
  const info=await modelInfo(model);
  const contextLength=Number(info?.context_length || 0);
  const estimatedInputTokens=estimateMessageTokens(messages);
  if (contextLength > 0) {
    const reserve=Math.max(config.openRouter.contextSafetyMarginTokens, Math.min(config.openRouter.maxOutputTokens, Math.floor(contextLength*0.12)));
    if (estimatedInputTokens + reserve >= contextLength) {
      const error=new Error(`Contexto grande demais para ${model}: ~${estimatedInputTokens.toLocaleString('pt-BR')} tokens de entrada + reserva ${reserve.toLocaleString('pt-BR')} excedem a janela publicada de ${contextLength.toLocaleString('pt-BR')} tokens. Refaça o Contexto canônico com menor orçamento antes de chamar a IA.`);
      error.name='OpenRouterContextError';
      error.details={category:'context_length',model,estimatedInputTokens,contextLength,reserveTokens:reserve};
      throw error;
    }
  }
  return {estimatedInputTokens,contextLength:contextLength || null};
}

async function requestChat({ model, messages, extra={}, useResponseFormat=true, requestVariant='default' }) {
  const context=await assertContextFits(messages,model);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),config.openRouter.requestTimeoutMs);
  const provider={ allow_fallbacks:config.openRouter.allowProviderFallbacks };
  if (useResponseFormat && config.openRouter.requireParameters) provider.require_parameters=true;
  const payload={
    model,
    messages,
    temperature:0.05,
    max_tokens:config.openRouter.maxOutputTokens,
    ...extra,
    provider:{...provider,...(extra.provider || {})},
  };
  if (!useResponseFormat) delete payload.response_format;
  try {
    const response=await fetch(`${config.openRouter.baseUrl}/chat/completions`,{
      method:'POST',
      headers:{
        'Authorization':`Bearer ${config.openRouter.apiKey}`,
        'Content-Type':'application/json',
        'HTTP-Referer':config.openRouter.siteUrl,
        'X-Title':config.openRouter.appName,
      },
      body:JSON.stringify(payload),
      signal:controller.signal,
    });
    const rawText=await response.text();
    let body={};
    try { body=rawText ? JSON.parse(rawText) : {}; } catch { body={error:{message:clip(rawText,5000)}}; }
    if (!response.ok) throw makeOpenRouterError({response,body,model,requestTokensEstimate:context.estimatedInputTokens,requestVariant});
    const message=body?.choices?.[0]?.message;
    if (!message?.content) {
      const error=new Error('OpenRouter retornou resposta vazia.');
      error.details={category:'empty_response',model,provider:body?.provider || null,requestId:body?.id || null,estimatedInputTokens:context.estimatedInputTokens};
      throw error;
    }
    message._openRouter={model:body?.model || model,provider:body?.provider || null,usage:body?.usage || null,requestId:body?.id || null,estimatedInputTokens:context.estimatedInputTokens,contextLength:context.contextLength};
    return message;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const wrapped=new Error(`Timeout da chamada OpenRouter após ${Math.round(config.openRouter.requestTimeoutMs/1000)}s.`);
      wrapped.details={category:'timeout',model,requestVariant,estimatedInputTokens:context.estimatedInputTokens};
      throw wrapped;
    }
    throw error;
  } finally { clearTimeout(timer); }
}

function canRetryTransient(error) {
  return ['provider_transient','rate_limit','timeout'].includes(error?.details?.category);
}
function canRetryWithoutStructured(error) {
  return ['structured_output','provider_transient','provider_error'].includes(error?.details?.category);
}

async function chat(messages, extra = {}) {
  if (!config.openRouter.apiKey) throw new Error('OPENROUTER_API_KEY não configurada. A extração funciona sem IA, mas a análise com IA exige a chave.');
  const models=[config.openRouter.model,...config.openRouter.fallbackModels.filter(x=>x!==config.openRouter.model)];
  const wantsResponseFormat=Boolean(extra.response_format) && config.openRouter.structuredOutputMode !== 'off';
  let lastError=null;

  for (const model of models) {
    const variants=[];
    if (wantsResponseFormat) variants.push({structured:true,label:'json-mode'});
    if (!wantsResponseFormat || config.openRouter.structuredOutputMode === 'auto') variants.push({structured:false,label:'plain-json'});

    for (const variant of variants) {
      const tries=variant.structured ? 2 : 1;
      for (let attempt=1; attempt<=tries; attempt++) {
        try {
          return await requestChat({model,messages,extra,useResponseFormat:variant.structured,requestVariant:`${variant.label}-${attempt}`});
        } catch (error) {
          lastError=error;
          const cat=error?.details?.category;
          if (['authentication','credits','context_length'].includes(cat)) throw error;
          if (variant.structured && !canRetryWithoutStructured(error) && !canRetryTransient(error)) break;
          if (attempt < tries && canRetryTransient(error)) { await sleep(1200*attempt); continue; }
          break;
        }
      }
      if (lastError && variant.structured && config.openRouter.structuredOutputMode === 'auto' && canRetryWithoutStructured(lastError)) continue;
      if (lastError) break;
    }
  }
  throw lastError || new Error('Falha desconhecida ao chamar OpenRouter.');
}

export async function openRouterDiagnostics({ probe=false }={}) {
  const info={
    configured:Boolean(config.openRouter.apiKey),
    baseUrl:config.openRouter.baseUrl,
    model:config.openRouter.model,
    fallbackModels:config.openRouter.fallbackModels,
    structuredOutputMode:config.openRouter.structuredOutputMode,
    requireParameters:config.openRouter.requireParameters,
    allowProviderFallbacks:config.openRouter.allowProviderFallbacks,
    requestTimeoutSeconds:Math.round(config.openRouter.requestTimeoutMs/1000),
    maxOutputTokens:config.openRouter.maxOutputTokens,
  };
  if (!config.openRouter.apiKey) return {...info,ok:false,error:'OPENROUTER_API_KEY não configurada.'};
  const model=await modelInfo(config.openRouter.model);
  info.catalogModel=model ? {id:model.id,name:model.name || null,contextLength:model.context_length || null} : null;
  if (!probe) return {...info,ok:true};
  try {
    const msg=await requestChat({
      model:config.openRouter.model,
      messages:[{role:'user',content:'Responda somente com OK.'}],
      extra:{temperature:0,max_tokens:8},
      useResponseFormat:false,
      requestVariant:'diagnostic-probe',
    });
    return {...info,ok:true,probe:{content:String(msg.content).slice(0,80),...msg._openRouter}};
  } catch (error) {
    return {...info,ok:false,error:error.message,details:error.details || null};
  }
}

function artifactCorpus(artifact) {
  // A Fase 1 entrega à IA o corpus integral/diagnóstico produzido na Fase 1: texto nativo,
  // OCR e estrutura machine-readable. Não usa apenas resumo nem preview.
  if (artifact.analysisCorpus?.combinedText) return artifact.analysisCorpus.combinedText;
  return JSON.stringify({
    nativeText:artifact.nativeText || artifact.text || '',
    ocrText:artifact.ocrText || '',
    machine:artifact.machine || {},
    coverage:artifact.coverage || null,
  }, null, 2);
}

function chunkText(text, size) {
  const chunks = [];
  for (let i=0; i<text.length; i+=size) chunks.push(text.slice(i, i+size));
  return chunks.length ? chunks : [''];
}

function evidencePrompt(file, userPrompt, part, total) {
  return `Você está na FASE 2 de uma análise de cronograma. A FASE 1 já converteu integralmente os arquivos para linguagem de máquina SEM IA, preservando texto nativo, OCR, estrutura e original.

PROMPT DE ANÁLISE DO USUÁRIO:
${userPrompt}

ARQUIVO EM LEITURA:
- Nome: ${file.name}
- Caminho relativo: ${file.relativePath}
- Modificado em: ${file.modifiedTime || 'N/D'}
- Parte: ${part}/${total}

Sua tarefa agora NÃO é gerar ainda a conclusão final da obra. Extraia deste trecho todas as evidências úteis para cumprir o prompt do usuário. Preserve números, datas, nomes de tarefas, IDs/WBS, percentuais, relações e divergências. Não invente nada.

Retorne SOMENTE JSON válido neste schema:
${INTERNAL_SCHEMA}`;
}

async function analyzeTextArtifact(file, artifact, userPrompt) {
  const corpus = artifactCorpus(artifact);
  const chunks = chunkText(corpus, config.aiChunkChars);
  const partials = [];
  for (let i=0; i<chunks.length; i++) {
    const msg = await chat([
      { role:'system', content:'Você é um analista sênior de planejamento e controle de obras. Trabalhe apenas com evidências fornecidas e preserve rastreabilidade.' },
      { role:'user', content:`${evidencePrompt(file,userPrompt,i+1,chunks.length)}\n\nCORPUS INTEGRAL EXTRAÍDO NA FASE 1 (TEXTO NATIVO + OCR + ESTRUTURA):\n${chunks[i]}` },
    ]);
    partials.push(parseLooseJson(msg.content));
  }
  if (partials.length === 1) return partials[0];

  const msg = await chat([
    { role:'system', content:'Consolide evidências de um mesmo documento sem perder datas, números, nomes, vínculos ou contradições. Retorne somente JSON válido.' },
    { role:'user', content:`PROMPT DO USUÁRIO:\n${userPrompt}\n\nARQUIVO: ${file.name}\n\nUna as leituras parciais abaixo no mesmo schema, removendo apenas repetição literal.\nSCHEMA:\n${INTERNAL_SCHEMA}\n\nPARCIAIS:\n${JSON.stringify(partials)}` },
  ]);
  return parseLooseJson(msg.content);
}

function imageMime(ext='') {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/jpeg';
}

async function analyzeVisualArtifact(file, artifact, userPrompt) {
  const bytes = await loadBlob(artifact.blobRef || artifact.sourceBlobRef);
  const dataUrl = artifact.kind === 'pdf'
    ? `data:application/pdf;base64,${bytes.toString('base64')}`
    : `data:${imageMime(file.ext)};base64,${bytes.toString('base64')}`;
  const mediaPart = artifact.kind === 'pdf'
    ? { type:'file', file:{ filename:file.name, file_data:dataUrl } }
    : { type:'image_url', image_url:{ url:dataUrl } };

  const msg = await chat([
    { role:'system', content:'Você é um analista sênior de planejamento e controle de obras. Leia o documento visual integralmente e não invente informações.' },
    { role:'user', content:[
      { type:'text', text:`${evidencePrompt(file,userPrompt,1,1)}\n\nEste arquivo foi preservado na FASE 1 para leitura multimodal somente agora, na FASE 2.` },
      mediaPart,
    ] },
  ]);
  return parseLooseJson(msg.content);
}



async function analyzeEmbeddedMedia(file, artifact, userPrompt) {
  const media = (artifact.embeddedMedia || []).filter(x => x?.blobRef && x?.mimeType?.startsWith('image/'));
  const out = [];
  for (let i=0; i<media.length; i++) {
    const item = media[i];
    const bytes = await loadBlob(item.blobRef);
    const dataUrl = `data:${item.mimeType || imageMime(item.ext)};base64,${bytes.toString('base64')}`;
    const msg = await chat([
      { role:'system', content:'Você é um analista sênior de planejamento de obras. Leia esta mídia incorporada ao documento, extraia somente evidências úteis ao cronograma e não invente informações. Retorne somente JSON válido.' },
      { role:'user', content:[
        { type:'text', text:`PROMPT DO USUÁRIO:\n${userPrompt}\n\nDOCUMENTO PAI: ${file.name}\nMÍDIA INCORPORADA: ${item.name}\nITEM ${i+1}/${media.length}\n\nRetorne o mesmo schema interno:\n${INTERNAL_SCHEMA}` },
        { type:'image_url', image_url:{ url:dataUrl } },
      ] },
    ]);
    out.push({ media:item.name, evidence:parseLooseJson(msg.content) });
  }
  return out;
}

async function mergeDocumentEvidence(file, userPrompt, machineEvidence, mediaEvidences) {
  if (!mediaEvidences?.length) return machineEvidence;
  const msg = await chat([
    { role:'system', content:'Una a leitura machine-readable e as leituras visuais de mídias incorporadas do MESMO documento. Preserve todas as evidências relevantes, sem duplicação e sem inventar. Retorne somente JSON válido.' },
    { role:'user', content:`PROMPT DO USUÁRIO:\n${userPrompt}\n\nDOCUMENTO: ${file.name}\n\nSCHEMA:\n${INTERNAL_SCHEMA}\n\nEVIDÊNCIA MACHINE-READABLE:\n${JSON.stringify(machineEvidence)}\n\nMÍDIAS INCORPORADAS:\n${JSON.stringify(mediaEvidences)}` },
  ]);
  return parseLooseJson(msg.content);
}


async function analyzeImageArtifact(file, artifact, userPrompt) {
  const machineEvidence = (artifact.text || '').trim()
    ? await analyzeTextArtifact(file, artifact, userPrompt)
    : null;
  const visualEvidence = await analyzeVisualArtifact(file, artifact, userPrompt);
  if (!machineEvidence) return visualEvidence;
  const msg = await chat([
    { role:'system', content:'Una a leitura OCR/machine-readable e a leitura visual da mesma imagem. Preserve fatos, textos reconhecidos, datas e sinalize divergências. Retorne somente JSON válido.' },
    { role:'user', content:`PROMPT DO USUÁRIO:
${userPrompt}

ARQUIVO: ${file.name}

SCHEMA:
${INTERNAL_SCHEMA}

EVIDÊNCIA OCR/MACHINE-READABLE:
${JSON.stringify(machineEvidence)}

EVIDÊNCIA VISUAL:
${JSON.stringify(visualEvidence)}` },
  ]);
  return parseLooseJson(msg.content);
}

async function analyzePdfArtifact(file, artifact, userPrompt) {
  const machineEvidence = (artifact.text || '').trim()
    ? await analyzeTextArtifact(file, artifact, userPrompt)
    : null;
  const visualEvidence = await analyzeVisualArtifact(file, artifact, userPrompt);
  if (!machineEvidence) return visualEvidence;

  const msg = await chat([
    { role:'system', content:'Una duas leituras do mesmo PDF: a camada machine-readable extraída na Fase 1 e a leitura multimodal do arquivo original. Preserve fatos e sinalize divergências. Retorne somente JSON válido.' },
    { role:'user', content:`PROMPT DO USUÁRIO:\n${userPrompt}\n\nARQUIVO: ${file.name}\n\nSCHEMA:\n${INTERNAL_SCHEMA}\n\nEVIDÊNCIA DA CAMADA MACHINE-READABLE:\n${JSON.stringify(machineEvidence)}\n\nEVIDÊNCIA MULTIMODAL DO PDF ORIGINAL:\n${JSON.stringify(visualEvidence)}` },
  ]);
  return parseLooseJson(msg.content);
}

export async function analyzeSnapshotFile(file, userPrompt) {
  if (!(file.artifactId || file.artifactKey)) throw new Error('Arquivo não possui JSON/artefato disponível no banco.');
  const artifact = loadArtifactFromDatabase(file.artifactId || file.artifactKey);
  // PDF e imagem são relidos do snapshot original na Fase 2 para não perder
  // gráficos, páginas escaneadas ou elementos visuais que não viram texto.
  if (artifact.kind === 'image' && (artifact.blobRef || artifact.sourceBlobRef)) {
    return analyzeImageArtifact(file, artifact, userPrompt);
  }
  if (artifact.kind === 'pdf' && (artifact.blobRef || artifact.sourceBlobRef)) {
    return analyzePdfArtifact(file, artifact, userPrompt);
  }
  if (artifact.kind === 'binary') {
    return {
      document_role:'Arquivo binário sem extrator específico', facts:[], dates:[], schedule_evidence:[], crosscheck_keys:[],
      warnings:[`O arquivo ${file.name} foi preservado integralmente, mas não existe extrator/entrada multimodal configurada para ${file.ext || 'este formato'}.`], coverage:'baixa'
    };
  }
  if (artifact.kind === 'diagnostic') {
    const reason = artifact.machine?.diagnostic?.reason || file.error || 'Extração parcial não especificada.';
    return {
      document_role:'Arquivo com extração técnica parcial', facts:[], dates:[], schedule_evidence:[], crosscheck_keys:[],
      warnings:[`O arquivo ${file.name} possui JSON de diagnóstico, mas a extração integral não foi concluída: ${reason}`], coverage:'baixa'
    };
  }
  const machineEvidence = await analyzeTextArtifact(file, artifact, userPrompt);
  const mediaEvidences = await analyzeEmbeddedMedia(file, artifact, userPrompt);
  return mergeDocumentEvidence(file, userPrompt, machineEvidence, mediaEvidences);
}

export async function consolidateSnapshot({ snapshot, userPrompt, evidences }) {
  const compact = evidences.map(x => ({
    file:x.file.name,
    path:x.file.relativePath,
    modifiedTime:x.file.modifiedTime,
    type:x.file.ext,
    evidence:x.evidence,
    error:x.error || null,
  }));

  const system = `Você é o motor final de análise de cronogramas da TOOLS Engenharia. Todos os arquivos foram primeiro extraídos integralmente SEM IA. Agora você recebe evidências obtidas pela IA a partir do corpus completo de TODOS os artefatos: texto nativo, OCR, estrutura machine-readable e leitura visual/original quando aplicável. Faça cross-check entre documentos, diferencie fato de inferência e nunca invente datas, percentuais, tarefas, marcos ou status.`;

  let evidencePayload = JSON.stringify(compact);
  // Evita estourar contexto quando a pasta tem muitos documentos. O agrupamento
  // acontece somente na Fase 2 e mantém os nomes dos arquivos para rastreabilidade.
  if (evidencePayload.length > 150000) {
    const batches = [];
    let current = [];
    let currentSize = 0;
    for (const item of compact) {
      const size = JSON.stringify(item).length;
      if (current.length && currentSize + size > 90000) {
        batches.push(current); current = []; currentSize = 0;
      }
      current.push(item); currentSize += size;
    }
    if (current.length) batches.push(current);

    const batchResults = [];
    for (let i=0; i<batches.length; i++) {
      const msg = await chat([
        { role:'system', content:'Consolide um lote de evidências de cronograma para uma etapa final posterior. Preserve nomes de arquivos, datas, números, divergências e fatos relevantes ao prompt. Não produza ainda a resposta final.' },
        { role:'user', content:`PROMPT FINAL DO USUÁRIO:\n${userPrompt}\n\nLOTE ${i+1}/${batches.length}:\n${JSON.stringify(batches[i])}` },
      ]);
      batchResults.push({ batch:i+1, content:msg.content });
    }
    evidencePayload = JSON.stringify(batchResults);
  }

  const user = `OBRA: ${snapshot.obra}\nÁREA: ${snapshot.area}\nPASTA: ${snapshot.folder?.path || ''}\nSNAPSHOT: ${snapshot.id}\nARQUIVOS EXTRAÍDOS: ${snapshot.totals?.extracted || 0}/${snapshot.totals?.files || 0}\n\nPROMPT DO USUÁRIO — SIGA-O COMO INSTRUÇÃO PRINCIPAL DE SAÍDA:\n${userPrompt}\n\nREGRAS DE RASTREABILIDADE:\n- Considere todos os documentos abaixo.\n- Quando houver conflito, cite quais arquivos divergem.\n- Preserve datas e números exatamente como sustentados pelas evidências.\n- Informe limitações quando um arquivo não puder ser lido integralmente.\n- Não trate o nome do arquivo como verdade se o conteúdo interno mostrar outra data/status.\n\nEVIDÊNCIAS POR DOCUMENTO/LOTE:\n${evidencePayload}`;
  const msg = await chat([{role:'system',content:system},{role:'user',content:user}], { temperature:0.05 });
  return msg.content;
}

const CANONICAL_EVIDENCE_SCHEMA = `{
  "section": "identificador do bloco",
  "facts": ["fatos concretos relevantes ao pacote"],
  "stratificationEvidence": [{"label":"", "source":"", "reason":""}],
  "milestones": [{"name":"", "date":null, "critical":null, "source":"", "taskId":null, "wbs":null}],
  "criticalPathEvidence": [{"name":"", "start":null, "finish":null, "slack":null, "source":"", "taskId":null, "wbs":null}],
  "overdueEvidence": [{"name":"", "finish":null, "pct":null, "source":"", "taskId":null, "wbs":null}],
  "versionChanges": [{"name":"", "from":null, "to":null, "deltaDays":null, "source":"", "taskId":null, "wbs":null}],
  "clientThirdPartyMilestones": [],
  "deadlineEvidence": [],
  "auxiliaryEvidence": [],
  "warnings": [],
  "traceability": [{"claim":"", "file":"", "path":"", "taskId":null, "wbs":null}]
}`;

function canonicalTokenEstimate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return estimatedTokensFromText(text);
}

function metricScalars(metrics={}) {
  const out={};
  for (const [k,v] of Object.entries(metrics || {})) {
    if (!Array.isArray(v)) out[k]=v;
  }
  return out;
}

function splitItemsByBudget(items=[], targetTokens, makeEnvelope) {
  const targetChars=Math.max(12000,Math.floor(targetTokens * Number(config.aiCharsPerTokenEstimate || 2.5)));
  const groups=[]; let current=[]; let size=0;
  for (const item of items || []) {
    const itemSize=JSON.stringify(item).length + 2;
    if (current.length && size + itemSize > targetChars) {
      groups.push(current); current=[]; size=0;
    }
    current.push(item); size += itemSize;
  }
  if (current.length || !groups.length) groups.push(current);
  return groups.map((group,index)=>makeEnvelope(group,index+1,groups.length));
}

function canonicalCommon(context) {
  return {
    schemaVersion:context.schemaVersion,
    contextType:context.contextType,
    purpose:context.purpose,
    package:context.package,
    snapshot:context.snapshot,
    selectedScheduleVersions:context.selectedScheduleVersions,
    analysisLayer:context.analysisLayer ? {mode:context.analysisLayer.mode,periodicity:context.analysisLayer.periodicity,requestedPeriods:context.analysisLayer.requestedPeriods,customComparison:context.analysisLayer.customComparison,requestedChange:context.analysisLayer.requestedChange,parentVersion:context.analysisLayer.parentVersion,rule:context.analysisLayer.rule} : null,
    traceability:context.traceability,
  };
}

function buildCanonicalChunks(context) {
  const target=config.openRouter.canonicalChunkTargetTokens;
  const common=canonicalCommon(context);
  const current=context?.schedule?.current || {};
  const metrics=context?.schedule?.metrics || current?.metrics || {};
  const chunks=[];
  const add=(section,data,part=1,total=1)=>chunks.push({
    ...common,
    chunk:{section,part,total,derivedFrom:'Contexto canônico para IA',note:'Este JSON é uma partição determinística do Contexto canônico original; nenhuma fonte externa foi adicionada.'},
    data,
  });

  add('overview',{
    schedule:{
      current:{source:current.source || null,projectInfo:current.projectInfo || null},
      metricScalars:metricScalars(metrics),
    },
    auxiliary:{counts:{documentIndex:context?.auxiliary?.documentIndex?.length||0,allDocumentDigests:context?.auxiliary?.allDocumentDigests?.length||0,selectedEvidence:context?.auxiliary?.selectedEvidence?.length||0}},
    userQualification:context?.userQualification || null,
  });

  if (context?.analysisLayer?.previousResult) add('previous_result',{previousResult:context.analysisLayer.previousResult});
  const deltaFiles=context?.analysisLayer?.deltaFiles || [];
  if(deltaFiles.length){
    for(const env of splitItemsByBudget(deltaFiles,target,(group,part,total)=>({section:'analysis_delta_files',part,total,group}))) add(env.section,{deltaFiles:env.group},env.part,env.total);
  }

  const tasks=current.tasks || [];
  for (const env of splitItemsByBudget(tasks,target,(group,part,total)=>({section:'current_tasks',part,total,group}))) {
    add(env.section,{source:current.source || null,projectInfo:current.projectInfo || null,tasks:env.group},env.part,env.total);
  }

  for (const key of ['overdue','criticalPath','milestones']) {
    const items=Array.isArray(metrics?.[key]) ? metrics[key] : [];
    if (!items.length) continue;
    for (const env of splitItemsByBudget(items,target,(group,part,total)=>({section:`metrics_${key}`,part,total,group}))) {
      add(env.section,{items:env.group},env.part,env.total);
    }
  }

  const comparisons=context?.schedule?.comparisons || [];
  comparisons.forEach((cmp,cmpIndex)=>{
    const changes=cmp?.changes || [];
    for (const env of splitItemsByBudget(changes,target,(group,part,total)=>({section:`comparison_${cmpIndex+1}`,part,total,group}))) {
      add(env.section,{from:cmp.from || null,to:cmp.to || null,changes:env.group},env.part,env.total);
    }
  });

  const index=context?.auxiliary?.documentIndex || [];
  if (index.length) {
    for (const env of splitItemsByBudget(index,target,(group,part,total)=>({section:'auxiliary_index',part,total,group}))) {
      add(env.section,{documentIndex:env.group},env.part,env.total);
    }
  }

  const digests=context?.auxiliary?.allDocumentDigests || [];
  if (digests.length) {
    for (const env of splitItemsByBudget(digests,target,(group,part,total)=>({section:'auxiliary_all_document_digests',part,total,group}))) {
      add(env.section,{allDocumentDigests:env.group},env.part,env.total);
    }
  }

  const evidence=context?.auxiliary?.selectedEvidence || [];
  if (evidence.length) {
    for (const env of splitItemsByBudget(evidence,target,(group,part,total)=>({section:'auxiliary_evidence',part,total,group}))) {
      add(env.section,{selectedEvidence:env.group},env.part,env.total);
    }
  }
  return chunks;
}

function evidenceSystemPrompt() {
  return `Você está executando uma etapa técnica intermediária do pacote TOOLS cronograma-html-tools. Receberá SOMENTE um bloco JSON pertencente ao \"Contexto canônico para IA\". Não use conhecimento externo para preencher lacunas. Extraia e preserve as evidências necessárias à análise final do pacote: estratificação, marcos, caminho crítico, tarefas vencidas, gate, comparação entre versões, prazo/baseline, marcos de cliente/terceiros, premissas e rastreabilidade. Não gere HTML e não produza ainda o JSON final. Não descarte datas, números, IDs, WBS ou divergências úteis. Retorne SOMENTE JSON válido no schema abaixo:\n${CANONICAL_EVIDENCE_SCHEMA}`;
}

function mergeUsage(total, meta) {
  const u=meta?.usage || {};
  total.requests += 1;
  for (const key of ['prompt_tokens','completion_tokens','total_tokens']) total[key]=(total[key]||0)+Number(u?.[key]||0);
  if (meta?.estimatedInputTokens) total.estimatedInputTokens=(total.estimatedInputTokens||0)+Number(meta.estimatedInputTokens||0);
  return total;
}

async function readCanonicalChunks(preparation,onProgress=()=>{}) {
  const chunks=buildCanonicalChunks(preparation.canonicalContext);
  const evidence=[];
  const usage={requests:0,prompt_tokens:0,completion_tokens:0,total_tokens:0,estimatedInputTokens:0};
  let maxChunkEstimatedInputTokens=0;
  for (let i=0;i<chunks.length;i++) {
    onProgress({phase:'canonical_read',index:i+1,total:chunks.length,section:chunks[i].chunk?.section || 'bloco'});
    const msg=await chat([
      {role:'system',content:evidenceSystemPrompt()},
      {role:'user',content:JSON.stringify(chunks[i])},
    ],{temperature:0.02,max_tokens:14000,response_format:{type:'json_object'}});
    const parsed=parseLooseJson(msg.content);
    evidence.push({chunk:chunks[i].chunk,evidence:parsed});
    mergeUsage(usage,msg._openRouter);
    maxChunkEstimatedInputTokens=Math.max(maxChunkEstimatedInputTokens,Number(msg._openRouter?.estimatedInputTokens||0));
  }
  return {chunks,evidence,usage,maxChunkEstimatedInputTokens};
}

async function reduceEvidenceIfNeeded({preparation,evidence,usage,onProgress=()=>{}}) {
  const maxTokens=config.openRouter.canonicalEvidenceMaxTokens;
  let level=0;
  let current=evidence;
  while (canonicalTokenEstimate(current) > maxTokens && current.length > 1 && level < 5) {
    level++;
    const target=Math.max(50000,Math.floor(maxTokens*0.55));
    const groups=splitItemsByBudget(current,target,(group,part,total)=>({group,part,total}));
    const reduced=[];
    for (let i=0;i<groups.length;i++) {
      onProgress({phase:'canonical_reduce',level,index:i+1,total:groups.length});
      const envelope={
        schemaVersion:preparation.canonicalContext.schemaVersion,
        contextType:'Contexto canônico para IA',
        processing:{mode:'hierarchical-reduction',level,part:i+1,total:groups.length,canonicalHash:preparation.contract?.canonicalHash || null},
        derivedEvidence:groups[i].group,
      };
      const msg=await chat([
        {role:'system',content:`Consolide evidências derivadas EXCLUSIVAMENTE do Contexto canônico para IA. Não acrescente fatos externos, não conclua o relatório final e não perca datas, valores, IDs/WBS, marcos, caminho crítico, atrasos, diferenças entre versões, premissas ou rastreabilidade. Remova somente repetição literal. Retorne SOMENTE JSON válido no mesmo schema de evidências:\n${CANONICAL_EVIDENCE_SCHEMA}`},
        {role:'user',content:JSON.stringify(envelope)},
      ],{temperature:0.02,max_tokens:16000,response_format:{type:'json_object'}});
      reduced.push({chunk:{section:`reduction_level_${level}`,part:i+1,total:groups.length},evidence:parseLooseJson(msg.content)});
      mergeUsage(usage,msg._openRouter);
    }
    current=reduced;
  }
  return {evidence:current,levels:level};
}

async function finalPreparedResultFromEvidence({preparation,evidence,validationErrors=[],usage,onProgress=()=>{}}) {
  const context=preparation.canonicalContext;
  const finalContext={
    schemaVersion:context.schemaVersion,
    contextType:'Contexto canônico para IA',
    purpose:context.purpose,
    package:context.package,
    snapshot:context.snapshot,
    selectedScheduleVersions:context.selectedScheduleVersions,
    userQualification:context.userQualification || null,
    analysisLayer:context.analysisLayer || null,
    processing:{
      mode:'hierarchical',
      canonicalHash:preparation.contract?.canonicalHash || null,
      statement:'Todo o conteúdo abaixo foi extraído exclusivamente de partições do Contexto canônico para IA. Nenhum JSON mestre, OCR bruto, arquivo original ou fonte externa foi adicionado.',
    },
    deterministicOverview:{
      scheduleCurrentSource:context?.schedule?.current?.source || null,
      projectInfo:context?.schedule?.current?.projectInfo || null,
      metrics:metricScalars(context?.schedule?.metrics || context?.schedule?.current?.metrics || {}),
    },
    canonicalEvidence:evidence,
    traceability:context.traceability,
  };
  const system=packageSystemPrompt(validationErrors);
  onProgress({phase:'final_synthesis'});
  const msg=await chat([
    {role:'system',content:system},
    {role:'user',content:JSON.stringify(finalContext)},
  ],{temperature:0.03,max_tokens:config.openRouter.maxOutputTokens,response_format:{type:'json_object'}});
  mergeUsage(usage,msg._openRouter);
  return {msg,finalContext};
}

export async function analyzePreparedSchedule({ preparation, onProgress=()=>{} }) {
  const context = preparation?.canonicalContext;
  if (!context) throw new Error('Preparação sem "Contexto canônico para IA". Gere novamente a etapa Preparar para IA.');
  if (context.contextType !== 'Contexto canônico para IA') throw new Error('Contrato de entrada inválido: o JSON não é o Contexto canônico para IA.');

  const canonicalJson=JSON.stringify(context);
  const systemBase=packageSystemPrompt([]);
  const oneShotEstimate=estimateMessageTokens([{role:'system',content:systemBase},{role:'user',content:canonicalJson}]);
  const safeLimit=config.openRouter.singleCallSafeInputTokens;
  const usage={requests:0,prompt_tokens:0,completion_tokens:0,total_tokens:0,estimatedInputTokens:0};
  let parsed=null, validationErrors=[], lastMeta=null, executionMode='single_call', chunkStats=null;

  if (oneShotEstimate <= safeLimit) {
    for (let attempt=1; attempt<=2; attempt++) {
      onProgress({phase:'single_call',attempt,total:2,estimatedInputTokens:oneShotEstimate});
      const system=packageSystemPrompt(validationErrors);
      const msg=await chat([
        {role:'system',content:system},
        {role:'user',content:canonicalJson},
      ],{temperature:0.03,response_format:{type:'json_object'}});
      lastMeta=msg._openRouter || null; mergeUsage(usage,lastMeta);
      try { parsed=parseLooseJson(msg.content); validationErrors=validatePreparedResult(parsed); }
      catch(error){ parsed=null; validationErrors=[`resposta não pôde ser convertida para JSON: ${error.message}`]; }
      if (!validationErrors.length) break;
    }
  } else {
    executionMode='hierarchical_canonical_chunks';
    const read=await readCanonicalChunks(preparation,onProgress);
    Object.assign(usage,read.usage);
    const reduced=await reduceEvidenceIfNeeded({preparation,evidence:read.evidence,usage,onProgress});
    chunkStats={chunkCount:read.chunks.length,reductionLevels:reduced.levels,maxChunkEstimatedInputTokens:read.maxChunkEstimatedInputTokens,evidenceEstimatedTokens:canonicalTokenEstimate(reduced.evidence)};
    for (let attempt=1; attempt<=2; attempt++) {
      const out=await finalPreparedResultFromEvidence({preparation,evidence:reduced.evidence,validationErrors,usage,onProgress});
      lastMeta=out.msg._openRouter || null;
      try { parsed=parseLooseJson(out.msg.content); validationErrors=validatePreparedResult(parsed); }
      catch(error){ parsed=null; validationErrors=[`resposta não pôde ser convertida para JSON: ${error.message}`]; }
      if (!validationErrors.length) break;
    }
  }

  if (validationErrors.length || !parsed) {
    const error=new Error(`A IA não produziu o JSON preparado compatível com o pacote TOOLS: ${validationErrors.join('; ')}`);
    error.details={category:'invalid_output',model:lastMeta?.model || config.openRouter.model,provider:lastMeta?.provider || null,usage,executionMode,chunkStats};
    throw error;
  }
  const profile=packageProfile();
  parsed.packageCompliance={...(parsed.packageCompliance||{}),package:'cronograma-html-tools',followed:true,packageHash:profile.packageHash,canonicalContextHash:preparation.contract?.canonicalHash || null};
  parsed.generatedAt=new Date().toISOString();
  parsed.inputContract='Contexto canônico para IA';
  parsed.outputContract='JSON de resultado preparado';
  parsed.aiExecution={
    model:lastMeta?.model || config.openRouter.model,
    provider:lastMeta?.provider || null,
    usage,
    requestId:lastMeta?.requestId || null,
    estimatedInputTokens:lastMeta?.estimatedInputTokens || null,
    executionMode,
    canonicalEstimatedInputTokens:oneShotEstimate,
    singleCallSafeInputTokens:safeLimit,
    chunkStats,
  };
  return parsed;
}


function normalizeQueryText(v=''){ return String(v??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim(); }
function followupKeywords(question=''){
  const stop=new Set(['para','como','qual','quais','porque','por','que','isso','essa','esse','uma','uns','das','dos','com','sem','sobre','me','de','do','da','no','na','em','e','ou']);
  return [...new Set(normalizeQueryText(question).split(' ').filter(x=>x.length>=3&&!stop.has(x)))].slice(0,30);
}
function scoreTextByKeywords(text='',keywords=[]){ const hay=normalizeQueryText(text); let score=0; for(const k of keywords) if(hay.includes(k)) score++; return score; }
function targetedCanonicalEvidence(context={},question=''){
  const kws=followupKeywords(question); const out={question,keywords:kws,snapshot:context.snapshot||null,userQualification:context.userQualification||null,analysisLayer:context.analysisLayer?{mode:context.analysisLayer.mode,periodicity:context.analysisLayer.periodicity,requestedPeriods:context.analysisLayer.requestedPeriods,parentVersion:context.analysisLayer.parentVersion}:null,tasks:[],versionChanges:[],documents:[]};
  const tasks=context?.schedule?.current?.tasks||[];
  out.tasks=tasks.map(t=>({score:scoreTextByKeywords(`${t.Name||''} ${t.WBS||''} ${t.Notes||''}`,kws),task:t})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,80).map(x=>x.task);
  const changes=(context?.schedule?.comparisons||[]).flatMap(c=>(c.changes||[]).map(ch=>({from:c.from,to:c.to,change:ch})));
  out.versionChanges=changes.map(x=>({score:scoreTextByKeywords(`${x.change?.name||''} ${x.change?.wbs||''}`,kws),...x})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,80).map(({score,...x})=>x);
  const docs=[...(context?.auxiliary?.selectedEvidence||[]),...(context?.auxiliary?.allDocumentDigests||[])];
  out.documents=docs.map(d=>({score:scoreTextByKeywords(`${d?.source?.name||''} ${d?.source?.relativePath||''} ${d?.evidence||''} ${d?.digest?.text||''} ${JSON.stringify(d?.summary||{})}`,kws),doc:d})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,18).map(x=>x.doc);
  return out;
}

export async function answerAnalysisFollowup({question,previousResult,preparation}){
  if(!String(question||'').trim()) throw new Error('Pergunta vazia.');
  const targeted=targetedCanonicalEvidence(preparation?.canonicalContext||{},question);
  const previous={executiveSummary:previousResult?.executiveSummary||[],analysis:previousResult?.analysis||previousResult?.scheduleAnalysis||null,findings:previousResult?.findings||previousResult?.keyFindings||null,assumptions:previousResult?.assumptions||previousResult?.premises||null,traceability:previousResult?.traceability||null,kitConfig:previousResult?.kitConfig?{meta:previousResult.kitConfig.meta||null,kpis:previousResult.kitConfig.kpis||[],leitura:previousResult.kitConfig.leitura||null,notas:previousResult.kitConfig.notas||[]}:null};
  const system='Você é o assistente de Análise de Cronograma da TOOLS. Responda à dúvida pontual do usuário usando PRIMEIRO o último resultado já gerado e SOMENTE as evidências direcionadas relacionadas à pergunta. Não reanalise o projeto inteiro, não refaça o relatório e não introduza períodos ou arquivos não presentes no contexto direcionado. Se a pergunta exigir uma nova versão completa da análise, diga de forma objetiva que ela deve ser gerada como nova versão e informe o que precisa ser comparado. Preserve datas, percentuais e rastreabilidade. Responda em português claro.';
  const msg=await chat([{role:'system',content:system},{role:'user',content:JSON.stringify({question,previousResult:previous,targetedEvidence:targeted})}],{temperature:0.05,max_tokens:5000});
  return {answer:msg.content,usage:msg._openRouter?.usage||null,model:msg._openRouter?.model||config.openRouter.model,provider:msg._openRouter?.provider||null,targetedStats:{tasks:targeted.tasks.length,versionChanges:targeted.versionChanges.length,documents:targeted.documents.length,keywords:targeted.keywords}};
}
