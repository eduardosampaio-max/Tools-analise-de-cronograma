import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { normalizeProjectBase, sourceModeForProjectBase } from '../domain/projectBase.js';
import { getProvider } from '../providers/index.js';
import { updateJob } from '../analysis/jobManager.js';
import {
  artifactKeyFor, hasArtifact, loadArtifact, publicArtifactInfo,
  saveArtifact, saveBlob, saveSnapshot, sha256, EXTRACTOR_VERSION, COMPATIBLE_EXTRACTOR_VERSIONS
} from './snapshotStore.js';
import {
  initDatabase, ensureProject, beginSyncRun, updateSyncRun, finishSyncRun,
  setFileArtifact, findArtifactByHash, saveArtifactRecord, loadArtifactRecord,
  getArtifactSummary, updateRunFile, dbDiagnostics
} from '../db/database.js';
import { planSync } from '../db/syncPlanner.js';
import { saveProjectDataset } from '../db/projectDatasetRepository.js';

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL('./fileWorker.js', import.meta.url));

async function mapConcurrent(items, concurrency, worker, onDone) {
  const result = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      result[i] = await worker(items[i], i);
      await onDone(result[i], i, [...result]);
    }
  }
  await Promise.all(Array.from({ length:Math.min(concurrency, items.length || 1) }, runner));
  return result;
}

function messageOf(error) { return error?.message || String(error || 'Erro desconhecido'); }

function diagnosticArtifact(file, error, { buffer=null, sourceBlobRef=null, contentHash=null, stage='extraction' } = {}) {
  const reason = messageOf(error);
  const diagnostic = {
    status:'partial', stage, reason, errorCode:error?.code || null,
    sourceReadable:Boolean(buffer), sourcePreserved:Boolean(sourceBlobRef),
    note:'O arquivo recebeu um JSON terminal de diagnóstico e não bloqueia a sincronização.',
  };
  const machine = {
    diagnostic,
    sourceMetadata:{
      name:file.name, relativePath:file.relativePath, path:file.path,
      extension:file.ext || null, size:file.size || buffer?.length || 0,
      modifiedTime:file.modifiedTime || null, mimeType:file.mimeType || null, source:file.source || null,
    },
  };
  const machineJson = JSON.stringify(machine, null, 2);
  const combinedText = `### ARQUIVO COM EXTRAÇÃO PARCIAL\nArquivo: ${file.name}\nMotivo: ${reason}\n\n### ESTRUTURA MACHINE-READABLE\n${machineJson}`;
  const coverage = {
    status:'partial', sourcePreserved:Boolean(sourceBlobRef), nativeStructuredExtraction:false,
    ocrEnabled:Boolean(config.ocr.enabled), ocrApplied:false, limitations:[reason],
  };
  return {
    schemaVersion:5, kind:'diagnostic', extractedBy:'Fallback resiliente',
    extractedAt:new Date().toISOString(), extractorVersion:EXTRACTOR_VERSION,
    machineReadable:true,
    source:{ name:file.name, relativePath:file.relativePath, modifiedTime:file.modifiedTime, size:file.size, mimeType:file.mimeType || null },
    metrics:{ bytes:buffer?.length || Number(file.size || 0), diagnosticErrors:1 },
    requiresVision:false, contentHash, sourceBlobRef, nativeText:'', ocrText:'', text:'',
    ocr:{ enabled:Boolean(config.ocr.enabled), applied:false, pending:false, interrupted:true, characters:0, diagnostic:true },
    machine, coverage,
    technicalSummary:{
      title:'Arquivo preservado com limitação técnica',
      narrative:`O arquivo foi identificado e recebeu um JSON de diagnóstico. Motivo: ${reason}`,
      bullets:[`Arquivo: ${file.name}`, sourceBlobRef ? 'Fonte original preservada.' : 'Fonte original não preservada nesta tentativa.', 'A sincronização continua normalmente.'],
      textPreview:'', headings:[], keywords:[], dates:[],
      ocr:{ applied:false, images:0, pages:0, characters:0 }, coverage,
    },
    analysisCorpus:{
      schemaVersion:1, coverage,
      sections:[{ id:'machine-json', type:'machine_json', label:'Diagnóstico machine-readable', text:machineJson }],
      stats:{ nativeCharacters:0, ocrCharacters:0, machineJsonCharacters:machineJson.length, combinedCharacters:combinedText.length, sections:1 },
      combinedText,
    },
  };
}

async function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      await Promise.race([
        execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true }),
        new Promise(resolve => setTimeout(resolve, 4000)),
      ]);
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

// Watchdog por INATIVIDADE + teto absoluto.
// Arquivo pesado pode continuar por bastante tempo se estiver reportando progresso.
// Se o processo ficar silencioso, ele é realmente morto e a fila segue.
function runIsolatedWorker(payload, { idleTimeoutMs, hardTimeoutMs, onMessage } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      stdio:['ignore', 'pipe', 'pipe', 'ipc'],
      env:{ ...process.env, ENV_FILE:config.envPath },
      windowsHide:true,
    });
    let settled = false;
    let lastStderr = '';
    let idleTimer;
    let hardTimer;
    let lastActivityAt = Date.now();

    child.stdout?.on('data', chunk => {
      if (process.env.WORKER_LOG === '1') process.stdout.write(`[WORKER:${payload.file?.name}] ${chunk}`);
    });
    child.stderr?.on('data', chunk => {
      lastStderr = `${lastStderr}${chunk.toString()}`.slice(-8000);
      if (process.env.WORKER_LOG === '1') process.stderr.write(`[WORKER:${payload.file?.name}] ${chunk}`);
    });

    const failAndKill = async (code, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer); clearTimeout(hardTimer);
      await killProcessTree(child);
      const error = new Error(text);
      error.code = code;
      error.workerKilled = true;
      reject(error);
    };

    const resetIdle = () => {
      lastActivityAt = Date.now();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void failAndKill('WORKER_IDLE_TIMEOUT', `Processo de “${payload.file?.name}” ficou ${Math.round(idleTimeoutMs/1000)}s sem reportar progresso e foi encerrado. O JSON/checkpoint já obtido será preservado.`);
      }, idleTimeoutMs);
    };
    resetIdle();
    hardTimer = setTimeout(() => {
      void failAndKill('WORKER_HARD_TIMEOUT', `Processo de “${payload.file?.name}” atingiu o teto absoluto de ${Math.round(hardTimeoutMs/1000)}s e foi encerrado para proteger a fila.`);
    }, hardTimeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer); clearTimeout(hardTimer);
      fn(value);
    };

    child.on('message', message => {
      resetIdle();
      onMessage?.({ ...message, workerLastActivityAt:new Date(lastActivityAt).toISOString() });
      if (message?.type === 'done') finish(resolve, message);
      if (message?.type === 'error') {
        const error = new Error(message.error || 'Falha no processo isolado.');
        error.code = message.code || 'WORKER_ERROR';
        error.checkpointSaved = Boolean(message.checkpointSaved);
        finish(reject, error);
      }
    });

    child.on('error', error => finish(reject, error));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const extra = lastStderr ? ` Detalhe: ${lastStderr.trim().slice(-1500)}` : '';
      const error = new Error(`Processo isolado encerrou antes de concluir (code=${code ?? '—'}, signal=${signal ?? '—'}).${extra}`);
      error.code = 'WORKER_EXIT';
      finish(reject, error);
    });

    child.send(payload);
  });
}

async function readSourceWithTimeout(provider, file) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      provider.readFile(file, { signal:controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error(`Leitura de “${file.name}” excedeu ${Math.round(config.fileReadTimeoutMs/1000)}s.`);
          error.code = 'READ_TIMEOUT';
          reject(error);
        }, config.fileReadTimeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function persistArtifactToDatabase(artifact, { contentHash=null, salt='' }={}) {
  return saveArtifactRecord(artifact, { contentHash:contentHash || artifact.contentHash || null, extractorVersion:EXTRACTOR_VERSION, salt });
}

async function markCheckpointPartial(cacheArtifactKey, reason, code='WORKER_INTERRUPTED') {
  try {
    const artifact = await loadArtifact(cacheArtifactKey);
    const limitation = `Processamento complementar interrompido: ${reason}`;
    const limitations = [...new Set([...(artifact.coverage?.limitations || []), limitation])];
    artifact.coverage = { ...(artifact.coverage || {}), status:'partial', limitations };
    if (artifact.analysisCorpus) artifact.analysisCorpus.coverage = artifact.coverage;
    artifact.ocr = { ...(artifact.ocr || {}), pending:false, interrupted:true, error:reason, interruptionCode:code };
    artifact.worker = { status:'interrupted', code, reason, interruptedAt:new Date().toISOString(), note:'A extração nativa já salva foi preservada.' };
    if (artifact.technicalSummary) {
      artifact.technicalSummary.coverage = artifact.coverage;
      artifact.technicalSummary.bullets = [...(artifact.technicalSummary.bullets || []), limitation];
      artifact.technicalSummary.narrative = `${artifact.technicalSummary.narrative || ''} ${limitation}`.trim();
    }
    await saveArtifact(cacheArtifactKey, artifact);
    return artifact;
  } catch { return null; }
}

async function extractOne(provider, file, onProgress) {
  const cacheArtifactKey = artifactKeyFor(file);
  let buffer = null;
  let sourceBlobRef = null;
  let contentHash = null;

  try {
    // Migração transparente de cache legado -> SQLite: um JSON completo já existente no cache
    // é importado para o SQLite sem repetir OCR/conversão.
    if (await hasArtifact(cacheArtifactKey)) {
      try {
        const legacy = await loadArtifact(cacheArtifactKey);
        if (legacy.kind !== 'diagnostic' && !legacy.worker?.interrupted && !legacy.ocr?.pending) {
          const artifactId = await persistArtifactToDatabase(legacy, { contentHash:legacy.contentHash || null, salt:`legacy:${file.relativePath}` });
          onProgress?.({ type:'stage', phase:'db_reuse', label:'JSON existente importado para o banco' });
          return { ...file, status:legacy.coverage?.status === 'partial' ? 'partial' : 'reused', cached:true, databaseReused:true, artifactId, cacheArtifactKey, contentHash:legacy.contentHash || null, extraction:publicArtifactInfo(legacy), error:null };
        }
      } catch {}
    }

    try {
      onProgress?.({ type:'stage', phase:'read', label:'Lendo arquivo e calculando hash' });
      buffer = await readSourceWithTimeout(provider, file);
      contentHash = sha256(buffer);

      // Reuso por conteúdo: mesmo que o nome/caminho seja novo, não repetimos OCR/conversão.
      const dbHit = findArtifactByHash(contentHash, EXTRACTOR_VERSION, COMPATIBLE_EXTRACTOR_VERSIONS);
      if (dbHit) {
        const artifact = loadArtifactRecord(dbHit.id);
        onProgress?.({ type:'stage', phase:'db_reuse', label:'Conteúdo já existe no banco; reutilizando JSON' });
        return {
          ...file, status:artifact.coverage?.status === 'partial' ? 'partial' : 'reused', cached:true, databaseReused:true,
          artifactId:dbHit.id, cacheArtifactKey:null, contentHash,
          extraction:dbHit.public_json ? JSON.parse(dbHit.public_json) : publicArtifactInfo(artifact), error:null,
        };
      }

      // Só preservamos uma cópia física quando realmente precisaremos extrair.
      sourceBlobRef = await saveBlob(cacheArtifactKey, file.ext || '.bin', buffer);
    } catch (error) {
      const artifact = diagnosticArtifact(file, error, { buffer, sourceBlobRef, contentHash, stage:'read' });
      const artifactId = await persistArtifactToDatabase(artifact, { contentHash, salt:`read:${file.relativePath}:${file.modifiedTime || ''}` });
      return { ...file, status:'partial', cached:false, artifactId, cacheArtifactKey:null, contentHash, extraction:publicArtifactInfo(artifact), error:messageOf(error) };
    }

    try {
      const message = await runIsolatedWorker({ file, artifactKey:cacheArtifactKey, sourceBlobRef, contentHash }, {
        idleTimeoutMs:config.fileWorkerIdleTimeoutMs,
        hardTimeoutMs:config.fileWorkerHardTimeoutMs,
        onMessage:onProgress,
      });
      const artifact = await loadArtifact(cacheArtifactKey);
      const artifactId = await persistArtifactToDatabase(artifact, { contentHash });
      const status = message.status === 'partial' || artifact.coverage?.status === 'partial' ? 'partial' : 'extracted';
      return { ...file, status, cached:false, artifactId, cacheArtifactKey, contentHash, extraction:publicArtifactInfo(artifact), error:status === 'partial' ? (artifact.coverage?.limitations || []).join(' | ') : null };
    } catch (error) {
      console.error(`[WORKER:${file.name}]`, error);
      const checkpoint = await markCheckpointPartial(cacheArtifactKey, messageOf(error), error?.code || 'WORKER_ERROR');
      if (checkpoint) {
        const artifactId = await persistArtifactToDatabase(checkpoint, { contentHash });
        return { ...file, status:'partial', cached:false, artifactId, cacheArtifactKey, contentHash, extraction:publicArtifactInfo(checkpoint), error:messageOf(error) };
      }
      const artifact = diagnosticArtifact(file, error, { buffer, sourceBlobRef, contentHash, stage:'isolated-worker' });
      const artifactId = await persistArtifactToDatabase(artifact, { contentHash, salt:`worker:${file.relativePath}:${file.modifiedTime || ''}` });
      return { ...file, status:'partial', cached:false, artifactId, cacheArtifactKey:null, contentHash, extraction:publicArtifactInfo(artifact), error:messageOf(error) };
    }
  } catch (error) {
    console.error(`[EXTRACT-FATAL:${file.name}]`, error);
    return { ...file, status:'failed', cached:false, artifactId:null, cacheArtifactKey:null, contentHash, extraction:null, error:messageOf(error) };
  }
}

function publicFromDbArtifact(artifactId) {
  const summary = getArtifactSummary(artifactId);
  if (!summary) return null;
  if (summary.public) return summary.public;
  return publicArtifactInfo(loadArtifactRecord(artifactId));
}

function makeSnapshot(job, folder, files, results, totalBytes, status='processing', syncCounts={}) {
  const materialized = files.map((source, index) => results[index] || ({ ...source, status:'queued', cached:false, artifactId:null, extraction:null, error:null, syncAction:'queued' }));
  const attempted = materialized.filter(f => !['queued','processing'].includes(f.status)).length;
  const extracted = materialized.filter(f => ['extracted','reused'].includes(f.status)).length;
  const partial = materialized.filter(f => f.status === 'partial').length;
  const failed = materialized.filter(f => f.status === 'failed').length;
  const cached = materialized.filter(f => f.cached).length;
  const artifacts = materialized.filter(f => f.artifactId).length;
  const completeCoverage = materialized.filter(f => f.extraction?.coverage?.status === 'complete').length;
  const partialCoverage = materialized.filter(f => f.extraction?.coverage?.status === 'partial').length;
  const corpusCharacters = materialized.reduce((sum,f) => sum + Number(f.extraction?.corpusStats?.combinedCharacters || 0), 0);
  const nativeCharacters = materialized.reduce((sum,f) => sum + Number(f.extraction?.corpusStats?.nativeCharacters || 0), 0);
  const ocrCharacters = materialized.reduce((sum,f) => sum + Number(f.extraction?.corpusStats?.ocrCharacters || 0), 0);
  const machineJsonCharacters = materialized.reduce((sum,f) => sum + Number(f.extraction?.corpusStats?.machineJsonCharacters || 0), 0);

  return {
    id:job.id, schemaVersion:6, extractorVersion:EXTRACTOR_VERSION, status,
    area:job.area, obra:job.obra, folder,
    createdAt:job.createdAt || new Date().toISOString(), updatedAt:new Date().toISOString(),
    aiUsed:false, sourceMode:config.driveMode, projectBase:normalizeProjectBase(job.projectBase || 'GO'), databaseBacked:true,
    totals:{
      files:files.length, attempted, pending:files.length-attempted,
      extracted, partial, failed, artifacts, cached, bytes:totalBytes,
      completeCoverage, partialCoverage, corpusCharacters, nativeCharacters, ocrCharacters, machineJsonCharacters,
      newFiles:syncCounts.new || 0, modifiedFiles:syncCounts.modified || 0, retryFiles:syncCounts.retry || 0, renamedFiles:syncCounts.renamed || 0,
      unchangedFiles:syncCounts.unchanged || 0, deletedFiles:syncCounts.deleted || 0, reusedArtifacts:syncCounts.reusedArtifacts || 0,
      toProcess:syncCounts.toProcess || 0,
    },
    files:materialized.map(f => ({
      id:f.id, name:f.name, ext:f.ext, path:f.path, relativePath:f.relativePath,
      size:f.size, modifiedTime:f.modifiedTime, mimeType:f.mimeType, source:f.source, stableId:f.stableId || null,
      status:f.status, syncAction:f.syncAction || null, previousRelativePath:f.previousRelativePath || null,
      cached:Boolean(f.cached), artifactId:f.artifactId || null, artifactKey:f.artifactId || null,
      extraction:f.extraction || null, error:f.error || null,
    })),
  };
}

function stageForProgress(file, index, total, message) {
  const base = `${index+1}/${total} · ${file.name}`;
  if (!message) return `Processando ${base}`;
  if (message.type === 'checkpoint') return `JSON nativo salvo para ${base}. Continuando OCR…`;
  if (message.phase === 'read') return `Lendo/hash ${base}`;
  if (message.phase === 'db_reuse') return `Reutilizando JSON do banco para ${base}`;
  if (message.phase === 'native_start') return `Extraindo estrutura nativa de ${base}`;
  if (message.phase === 'ocr_start') return `OCR iniciado em ${base}`;
  if (message.phase === 'ocr_pdf_page') return `OCR ${base} · página ${message.page}/${message.totalPages}`;
  if (message.phase === 'ocr_embedded') return `OCR ${base} · mídia ${message.index}/${message.total}: ${message.label || ''}`;
  if (message.phase === 'ocr_engine' && message.status) return `OCR ${base} · ${message.status}${message.progress != null ? ` ${message.progress}%` : ''}`;
  if (message.label) return `${message.label}: ${base}`;
  return `Processando ${base}`;
}

export async function runExtraction(job) {
  let project = null;
  try {
    initDatabase();
    const provider = await getProvider();
    const projectBase=normalizeProjectBase(job.projectBase || 'GO');
    updateJob(job.id, { status:'processing', stage:`Acessando base ${projectBase}…`, progress:2, error:null, projectBase });
    const folder = await provider.locateCronograma(job.area, job.obra, projectBase);
    updateJob(job.id, { stage:`Pasta acessada: ${folder.path}`, progress:5, folder });

    let files = await provider.listCronogramaFiles(folder);
    files = files.filter(f => !f.name.startsWith('~$'));
    if (!files.length) throw new Error(`A pasta CRONOGRAMA foi encontrada em “${folder.path}”, mas não contém arquivos.`);

    const totalBytes = files.reduce((sum,f) => sum + Number(f.size || 0), 0);
    project = ensureProject({ area:job.area, obra:job.obra, folderPath:folder.path, sourceMode:sourceModeForProjectBase(config.driveMode,projectBase) });
    beginSyncRun({ id:job.id, projectId:project.id, totalFiles:files.length, bytesScanned:totalBytes });

    updateJob(job.id, { stage:`Comparando ${files.length} arquivo(s) com o banco…`, progress:7 });
    const { plan, deleted, counts } = planSync({ projectId:project.id, runId:job.id, files, extractorVersion:EXTRACTOR_VERSION, compatibleExtractorVersions:COMPATIBLE_EXTRACTOR_VERSIONS, retryPartial:Boolean(job.retryPartial) });
    updateSyncRun(job.id, {
      new_files:counts.new, modified_files:counts.modified, retry_files:counts.retry || 0, renamed_files:counts.renamed,
      unchanged_files:counts.unchanged, deleted_files:counts.deleted,
    });

    const results = new Array(files.length);
    let reusedByMetadata = 0;
    for (const item of plan) {
      if (!item.needsProcessing && item.artifactId) {
        const extraction = publicFromDbArtifact(item.artifactId);
        const reusedStatus = extraction?.coverage?.status === 'partial' ? 'partial' : 'reused';
        results[item.index] = {
          ...item.file, status:reusedStatus, cached:true, artifactId:item.artifactId, extraction, error:reusedStatus === 'partial' ? (extraction?.coverage?.limitations || []).join(' | ') : null,
          syncAction:item.action, previousRelativePath:item.previousRelativePath,
        };
        updateRunFile(job.id, item.index, { status:reusedStatus, artifact_id:item.artifactId, error:results[item.index].error || null });
        reusedByMetadata += 1;
      }
    }

    let syncCounts = { ...counts, reusedArtifacts:0 };
    let snapshot = makeSnapshot(job, folder, files, results, totalBytes, 'processing', syncCounts);
    await saveSnapshot(snapshot); // compatibilidade/backup; a fonte de verdade é SQLite.

    updateJob(job.id, {
      totalFiles:files.length, processedFiles:reusedByMetadata, progress:10,
      stage:`Diff concluído: ${counts.toProcess} precisam de leitura; ${counts.unchanged} inalterado(s); ${counts.renamed} renomeado(s); ${counts.deleted} removido(s).`,
      files:snapshot.files, folder,
      database:dbDiagnostics(),
      syncDiff:counts,
      result:{ snapshotId:job.id, aiUsed:false, readyForReview:true, readyForAi:counts.toProcess === 0 },
    });

    const work = sortWorkQueue(plan.filter(x => x.needsProcessing));
    let done = reusedByMetadata;
    let newlyProcessed = 0;
    let reusedByHash = 0;
    let partialCount = 0;
    let failedCount = 0;
    const lastUiUpdate = new Map();

    await mapConcurrent(work, config.extractionConcurrency, async (planned) => {
      const { file, index } = planned;
      const startedAt = Date.now();
      updateRunFile(job.id, index, { status:'processing' });
      updateJob(job.id, {
        stage:`Iniciando ${index+1}/${files.length} · ${file.name}`,
        currentFile:{ index:index+1,total:files.length,name:file.name,phase:'starting',startedAt:new Date(startedAt).toISOString(),idleWatchdogSeconds:Math.round(config.fileWorkerIdleTimeoutMs/1000),hardLimitSeconds:Math.round(config.fileWorkerHardTimeoutMs/1000) },
      });

      const item = await extractOne(provider, file, message => {
        const now = Date.now();
        const last = lastUiUpdate.get(index) || 0;
        if (now-last < 350 && message?.phase === 'ocr_engine') return;
        lastUiUpdate.set(index,now);
        updateJob(job.id, {
          stage:stageForProgress(file,index,files.length,message),
          currentFile:{
            index:index+1,total:files.length,name:file.name,phase:message?.phase || 'processing',detail:message?.label || message?.status || null,
            startedAt:new Date(startedAt).toISOString(),elapsedSeconds:Math.round((now-startedAt)/1000),
            lastActivityAt:message?.workerLastActivityAt || new Date(now).toISOString(),
            idleWatchdogSeconds:Math.round(config.fileWorkerIdleTimeoutMs/1000),hardLimitSeconds:Math.round(config.fileWorkerHardTimeoutMs/1000),
          },
        });
      });
      item.syncAction = planned.action;
      item.previousRelativePath = planned.previousRelativePath;
      return { item, planned };
    }, async (wrapped) => {
      const { item, planned } = wrapped;
      const index = planned.index;
      results[index] = item;
      done += 1;
      newlyProcessed += 1;
      if (item.databaseReused) reusedByHash += 1;
      if (item.status === 'partial') partialCount += 1;
      if (item.status === 'failed') failedCount += 1;

      if (item.artifactId) {
        setFileArtifact(planned.fileRecord.id, {
          artifactId:item.artifactId, contentHash:item.contentHash || null, extractorVersion:EXTRACTOR_VERSION,
          status:item.status, coverageStatus:item.extraction?.coverage?.status || null, error:item.error || null,
        });
      } else {
        setFileArtifact(planned.fileRecord.id, {
          artifactId:null, contentHash:item.contentHash || null, extractorVersion:EXTRACTOR_VERSION,
          status:item.status, coverageStatus:null, error:item.error || null,
        });
      }
      updateRunFile(job.id, index, { status:item.status, artifact_id:item.artifactId || null, error:item.error || null, ...(planned.file?.recoveredSource ? { source_json:JSON.stringify(planned.file) } : {}) });

      syncCounts = { ...counts, reusedArtifacts:reusedByHash };
      updateSyncRun(job.id, {
        reused_artifacts:reusedByHash, processed_files:newlyProcessed,
        partial_files:partialCount, failed_files:failedCount,
      });

      snapshot = makeSnapshot(job, folder, files, results, totalBytes, 'processing', syncCounts);
      await saveSnapshot(snapshot);
      updateJob(job.id, {
        processedFiles:done,
        progress:10 + Math.round((done/files.length)*84),
        stage:`${fileStatusLabel(item.status)} · ${planned.file.name}. Banco atualizado; seguindo para o próximo.`,
        currentFile:null, files:snapshot.files, syncDiff:syncCounts,
        result:{ snapshotId:job.id, aiUsed:false, readyForReview:true, readyForAi:false },
      });
    });

    const finalPartial = results.filter(x=>x?.status==='partial').length;
    const finalFailed = results.filter(x=>x?.status==='failed').length;
    const finalStatus = finalFailed || finalPartial ? 'partial' : 'completed';
    syncCounts = { ...counts, reusedArtifacts:reusedByHash };
    snapshot = makeSnapshot(job, folder, files, results, totalBytes, finalStatus, syncCounts);
    await saveSnapshot(snapshot);
    finishSyncRun(job.id, {
      status:finalStatus, reused_artifacts:reusedByHash, processed_files:newlyProcessed,
      partial_files:finalPartial, failed_files:finalFailed, error:null,
    });
    // Persiste o manifesto do JSON lógico do projeto. Os artefatos
    // integrais continuam normalizados, evitando duplicar um corpus gigantesco.
    try { saveProjectDataset({snapshot,projectId:project.id}); } catch (error) { console.warn('[PROJECT DATASET]',error.message); }

    updateJob(job.id, {
      status:finalStatus, progress:100, currentFile:null,
      stage:counts.toProcess === 0
        ? `Sincronização concluída sem reextração: ${files.length} arquivo(s) já estavam atualizados no banco.`
        : `Sincronização concluída: ${counts.toProcess} candidato(s) processados; ${counts.unchanged} inalterado(s); ${counts.renamed} renomeado(s); ${reusedByHash} JSON(s) reaproveitados por hash.`,
      error:null, database:dbDiagnostics(), syncDiff:syncCounts,
      result:{ snapshotId:job.id, snapshot, aiUsed:false, readyForReview:true, readyForAi:true },
      files:snapshot.files,
    });
  } catch (error) {
    console.error('[EXTRACTION]', error);
    try { if (project) finishSyncRun(job.id, { status:'failed', error:messageOf(error) }); } catch {}
    updateJob(job.id, { status:'failed', progress:100, currentFile:null, stage:'Falha na sincronização', error:messageOf(error) });
  }
}


function workPriority(item) {
  const ext = String(item.file?.ext || '').toLowerCase();
  const name = String(item.file?.name || '').toLowerCase();
  let p = 70;
  if (ext === '.mpp') p = 0;
  else if (ext === '.xml') p = 10;
  else if (['.xlsx','.xlsm','.xls','.xlsb','.csv'].includes(ext)) p = 20;
  else if (['.docx','.doc','.pptx','.ppt'].includes(ext)) p = 30;
  else if (ext === '.pdf') p = 40;
  else if (['.png','.jpg','.jpeg','.webp','.bmp','.tif','.tiff'].includes(ext)) p = 50;
  if (/cronograma|planejamento|baseline|linha.?base|programa[cç][aã]o/.test(name)) p -= 5;
  return p;
}

function sortWorkQueue(items) {
  return [...items].sort((a,b) => {
    const pa = workPriority(a), pb = workPriority(b);
    if (pa !== pb) return pa-pb;
    return Number(a.file?.size || 0) - Number(b.file?.size || 0);
  });
}

function fileStatusLabel(status) {
  if (status === 'extracted') return 'Extraído';
  if (status === 'reused') return 'JSON reaproveitado';
  if (status === 'partial') return 'Parcial';
  if (status === 'failed') return 'Falhou';
  return status;
}
