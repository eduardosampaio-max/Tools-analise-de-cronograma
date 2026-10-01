import { config } from '../config.js';
import { updateJob } from './jobManager.js';
import { loadSnapshotFromDatabase } from '../db/snapshotRepository.js';
import { loadPreparation } from '../db/preparationRepository.js';
import { analyzePreparedSchedule } from '../ai/openRouter.js';
import { savePreparedAiResult, loadPreparedAiResult, saveAnalysisContext } from './resultStore.js';
import { renderHtmlResult } from './renderHtmlResult.js';
import crypto from 'node:crypto';
import { getChatSession, updateChatSession } from '../db/chatRepository.js';
import { qualificationComplete } from './chatQualification.js';
import { buildSessionAnalysisPreparation } from './incrementalAnalysisContext.js';
import { getAnalysisVersion, updateAnalysisVersion } from '../db/analysisVersionRepository.js';

export async function runAiAnalysis(job) {
  let preparedResult=null;
  let savedPath=null;
  let phase='ai';
  let snapshot=null;
  let preparation=null;
  try {
    if (!config.openRouter.apiKey) throw new Error('OPENROUTER_API_KEY não configurada. Sincronização e Contexto canônico funcionam sem IA; esta etapa exige a chave.');
    if (!job.preparationId) throw new Error('Gere primeiro o Contexto canônico para IA.');

    snapshot = loadSnapshotFromDatabase(job.snapshotId);
    if (snapshot.status === 'processing') throw new Error('A extração ainda está em andamento.');
    preparation = loadPreparation(job.preparationId);
    if (preparation.snapshotId !== snapshot.id) throw new Error('A preparação selecionada não pertence a este snapshot.');
    if (!preparation.canonicalContext) throw new Error('A preparação está desatualizada. Gere novamente o Contexto canônico para IA.');

    // Cada execução recebe uma camada de análise por período.
    // Na primeira versão, usa somente os períodos escolhidos + contexto canônico.
    // Nas atualizações, parte do último resultado e adiciona apenas o delta dos arquivos e as versões selecionadas.
    if (job.chatSessionId) {
      const session=getChatSession(job.chatSessionId);
      if (!session) throw new Error('Sessão de chat não encontrada.');
      if (session.snapshotId !== snapshot.id) throw new Error('A sessão de chat não pertence ao projeto/snapshot selecionado.');
      if (!qualificationComplete(session.state)) throw new Error('Responda às perguntas de qualificação antes de analisar.');
      const previousVersion=job.parentAnalysisVersionId ? getAnalysisVersion(job.parentAnalysisVersionId) : null;
      let previousResult=null;
      if(previousVersion?.analysisId){ try{ previousResult=await loadPreparedAiResult(previousVersion.analysisId); }catch{} }
      preparation=buildSessionAnalysisPreparation({session,snapshot,basePreparation:preparation,previousVersion,previousResult});
      await saveAnalysisContext(job.id,preparation.canonicalContext);
      updateChatSession(session.id,{status:'analyzing',analysisId:job.id,state:{...session.state,status:'analyzing',analysisVersionId:job.analysisVersionId||session.state?.analysisVersionId||null}});
    }
    if (!(preparation.schedule?.selectedVersions?.length > 0)) throw new Error('O pacote TOOLS exige cronograma nativo (.mpp/.xml/.xer). O Contexto canônico não possui versão nativa selecionada.');

    updateJob(job.id, {
      status:'processing',
      stage:`IA lendo a camada canônica desta versão (${Number(preparation.stats?.estimatedTokens||0).toLocaleString('pt-BR')} tokens estimados)…`,
      progress:20,
      totalFiles:snapshot.totals?.files || 0,
      processedFiles:0,
    });

    preparedResult = await analyzePreparedSchedule({
      preparation,
      onProgress:(info={})=>{
        let stage='IA processando o Contexto canônico…';
        let progress=45;
        if (info.phase === 'canonical_read') {
          stage=`Luna lendo Contexto canônico em blocos: ${info.index}/${info.total} · ${info.section || ''}`;
          progress=20 + Math.round((info.index/Math.max(1,info.total))*45);
        } else if (info.phase === 'canonical_reduce') {
          stage=`Consolidando evidências canônicas · nível ${info.level} · ${info.index}/${info.total}`;
          progress=70 + Math.round((info.index/Math.max(1,info.total))*10);
        } else if (info.phase === 'final_synthesis') {
          stage='Luna gerando o JSON de resultado preparado conforme o pacote TOOLS…';
          progress=85;
        } else if (info.phase === 'single_call') {
          stage=`Luna analisando Contexto canônico em chamada única · tentativa ${info.attempt}/${info.total}`;
          progress=55;
        }
        updateJob(job.id,{status:'processing',stage,progress,totalFiles:snapshot.totals?.files||0,processedFiles:0});
      },
    });
    savedPath = await savePreparedAiResult(job.id, preparedResult);
    phase='render';
    updateJob(job.id, { status:'processing', progress:92, stage:'JSON preparado validado. Montando saída HTML com a skill cronograma-html-tools…' });
    const htmlManifest = await renderHtmlResult({
      analysisId:job.id, snapshot, preparation, preparedResult,
      onProgress:(info={})=>{
        let progress=94;
        if (info.phase === 'render_validate') progress=96;
        if (info.phase === 'render_html') progress=98;
        updateJob(job.id,{status:'processing',progress,stage:info.message || 'Gerando HTML TOOLS…'});
      },
    });
    if (job.chatSessionId) {
      const session=getChatSession(job.chatSessionId);
      if (session) updateChatSession(session.id,{status:'completed',analysisId:job.id,state:{...session.state,status:'completed',completedAt:new Date().toISOString()}});
    }
    if(job.analysisVersionId){
      updateAnalysisVersion(job.analysisVersionId,{status:'completed',analysisId:job.id,snapshotId:snapshot.id,completedAt:new Date().toISOString(),resultSummary:{executiveSummary:preparedResult?.executiveSummary||[],html:htmlManifest?.html?.name||null,model:preparedResult?.aiExecution?.model||config.openRouter.model,executionMode:preparedResult?.aiExecution?.executionMode||null}});
    }
    updateJob(job.id, {
      status:'completed', progress:100, stage:'HTML TOOLS gerado conforme a skill e pronto para abrir.',
      result:{
        snapshotId:snapshot.id,
        preparationId:preparation.id,
        analysisId:job.id,
        analysisVersionId:job.analysisVersionId || null,
        area:snapshot.area, obra:snapshot.obra,
        model:preparedResult?.aiExecution?.model || config.openRouter.model,
        provider:preparedResult?.aiExecution?.provider || null,
        usage:preparedResult?.aiExecution?.usage || null,
        generatedAt:new Date().toISOString(),
        tokenEstimate:preparation.stats?.estimatedTokens || null,
        masterCharacters:preparation.stats?.masterCharacters || null,
        preparedCharacters:preparation.stats?.preparedCharacters || null,
        reductionPct:preparation.stats?.reductionPct || null,
        canonicalContextHash:preparation.contract?.canonicalHash || null,
        packageHash:preparedResult.packageCompliance?.packageHash || null,
        savedPath,
        preparedResult,
        html:{ name:htmlManifest.html.name, bytes:htmlManifest.html.bytes, hasData:Boolean(htmlManifest.data), hasCsv:Boolean(htmlManifest.csv) },
      },
    });
  } catch (error) {
    console.error('[AI ANALYSIS]', error, error?.details || '');
    const partialResult = preparedResult ? {
      snapshotId:snapshot?.id || job.snapshotId, preparationId:preparation?.id || job.preparationId, analysisId:job.id,
      area:snapshot?.area || null, obra:snapshot?.obra || null, model:preparedResult?.aiExecution?.model || config.openRouter.model,
      generatedAt:new Date().toISOString(), savedPath, preparedResult, renderFailed:phase==='render',
    } : undefined;
    if (job.chatSessionId) {
      try {
        const session=getChatSession(job.chatSessionId);
        if (session) updateChatSession(session.id,{status:'failed',analysisId:job.id,state:{...session.state,status:'failed',lastError:error.message}});
      } catch {}
    }
    if(job.analysisVersionId){ try{updateAnalysisVersion(job.analysisVersionId,{status:'failed'});}catch{} }
    updateJob(job.id, {
      status:'failed', progress:100, stage:phase==='render' ? 'IA concluída, mas falhou ao gerar o HTML Tools' : 'Falha na análise com IA',
      error:error.message, errorDetails:error?.details || null, ...(partialResult ? {result:partialResult}:{}),
    });
  }
}
