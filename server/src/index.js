import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import cors from 'cors';
import archiver from 'archiver';
import { config } from './config.js';
import { getProvider } from './providers/index.js';
import { createJob, getJob, subscribe, updateJob } from './analysis/jobManager.js';
import { startIncrementalSync, waitForJob } from './sync/syncService.js';
import { startAutoSyncScheduler, autoSyncDiagnostics } from './sync/autoSyncScheduler.js';
import { initSyncScheduleSchema, getSyncSchedule, upsertSyncSchedule, syncScheduleDiagnostics } from './db/syncScheduleRepository.js';
import { initDatabase, dbDiagnostics, findProject, latestSyncForProject } from './db/database.js';
import { initPreparationSchema, latestPreparationForSnapshot, loadPreparation } from './db/preparationRepository.js';
import { prepareSnapshotForAi } from './preparation/prepareForAi.js';
import { packageProfile } from './package/cronogramaPackage.js';
import { loadPreparedAiResult, loadAnalysisContext } from './analysis/resultStore.js';
import { loadRenderManifest } from './analysis/renderHtmlResult.js';
import { openRouterDiagnostics } from './ai/openRouter.js';
import { loadSnapshotFromDatabase, loadArtifactFromDatabase } from './db/snapshotRepository.js';
import { initChatSchema, createChatSession, getChatSession, updateChatSession, latestChatSessionForSnapshot, latestChatSessionForProject } from './db/chatRepository.js';
import { initProjectDatasetSchema, saveProjectDataset, getProjectDataset } from './db/projectDatasetRepository.js';
import { buildQualification, qualificationComplete } from './analysis/chatQualification.js';
import { initAnalysisVersionSchema, latestAnalysisVersion, listAnalysisVersions, createAnalysisVersion, updateAnalysisVersion, getAnalysisVersion, addChatMessage, listChatMessages } from './db/analysisVersionRepository.js';
import { answerAnalysisFollowup } from './ai/openRouter.js';
import { normalizeProjectBase, sourceModeForProjectBase, relativeCronogramaPath } from './domain/projectBase.js';

initDatabase();
initPreparationSchema();
initChatSchema();
initProjectDatasetSchema();
initSyncScheduleSchema();
initAnalysisVersionSchema();
const app = express();
app.use(cors());
app.use(express.json({ limit:'4mb' }));

process.on('unhandledRejection', reason => console.error('[UNHANDLED REJECTION]', reason));

app.get('/api/ping', (_req,res) => {
  res.json({ ok:true, api:'online', timestamp:new Date().toISOString() });
});

app.get('/api/health', async (_req,res) => {
  try {
    let localRoots = {};
    if (config.driveMode === 'local') {
      const provider = await getProvider();
      if (typeof provider.getDiagnostics === 'function') localRoots = await provider.getDiagnostics();
    }
    let mppAvailable = false;
    let mppError = null;
    try {
      const mppModule = await import('@byteink/mppjs');
      mppAvailable = typeof mppModule.convert === 'function';
    } catch (error) { mppError = error.message; }

    const { getOcrDiagnostics } = await import('./extraction/ocr.js');
    const ocr = await getOcrDiagnostics();

    res.json({
      ok:true, api:'online', architecture:'versioned-period-analysis-incremental-chat-context',
      driveMode:config.driveMode, envFile:config.envPath, localRoots,
      extraction:{ usesAI:false, maxFileMB:Math.round(config.maxFileBytes/1024/1024), concurrency:config.extractionConcurrency, readTimeoutSeconds:Math.round(config.fileReadTimeoutMs/1000), idleWatchdogSeconds:Math.round(config.fileWorkerIdleTimeoutMs/1000), hardLimitSeconds:Math.round(config.fileWorkerHardTimeoutMs/1000), isolation:'child_process_per_file', hardKill:true, nativeCheckpointBeforeOcr:true, persistentDiff:true, renameDetection:true, contentHashReuse:true, producesTechnicalSummary:true, producesFullCorpus:true, preservesOriginal:true, incrementalSnapshot:true, diagnosticJsonOnError:true, sourcePathRecovery:true, transientReadRetry:true, jsonPackageDownload:true, streamingZipDownload:true, ocrRetryPipeline:true, scheduledIncrementalSync:true, preAnalysisRefresh:true },
      database:dbDiagnostics(),
      autoSync:{...autoSyncDiagnostics(),...syncScheduleDiagnostics(),beforeAnalysis:config.autoSync.preAnalysisRefresh},
      projectBases:{GO:{label:'GO',rule:'<OBRA>/GO/CRONOGRAMA'},GP:{label:'GP',rules:{RESIDENCIAL:'<OBRA>/GP/COORD/CRONOGRAMA',CORPORATIVO:'<OBRA>/GP/COORD/CRONOGRAMA',PREDIAL:'<OBRA>/COORD/CRONOGRAMA'}}},
      ocr,
      chat:{ enabled:true, projectSelection:true, projectBaseSelection:['GO','GP'], qualificationBeforeAnalysis:true, periodicityRequired:true, comparisonPeriodsRequired:true, persistentSessions:true, analysisVersionHistory:true, incrementalFollowups:true, finalOutput:'HTML + JSON + CSV' },
      ai:{ configured:Boolean(config.openRouter.apiKey), model:config.openRouter.model, fallbackModels:config.openRouter.fallbackModels, onlyRunsAfterSnapshot:true, preparationRequired:true, inputContract:'Contexto canônico para IA somente', outputContract:'JSON de resultado preparado + HTML determinístico via skill cronograma-html-tools', packageLocked:true, charsPerTokenEstimate:config.aiCharsPerTokenEstimate, auxSnippetChars:config.aiAuxSnippetChars, maxAuxDocuments:config.aiMaxAuxDocuments, requestTimeoutSeconds:Math.round(config.openRouter.requestTimeoutMs/1000), maxOutputTokens:config.openRouter.maxOutputTokens, structuredOutputMode:config.openRouter.structuredOutputMode, requireParameters:config.openRouter.requireParameters, allowProviderFallbacks:config.openRouter.allowProviderFallbacks },
      packageWorkflow:packageProfile(),
      htmlOutput:{ enabled:true, engine:'cronograma-html-tools/scripts/gerar_html.py', template:'cronograma-html-tools/assets/cronograma_marcos_template.html', opensInline:true, outputPackage:true, pythonBin:process.env.PYTHON_BIN || 'auto' },
      mppReader:{ engine:'@byteink/mppjs (MPXJ nativo)', available:mppAvailable, error:mppError },
    });
  } catch (error) {
    console.error('[HEALTH]', error);
    res.status(500).json({ error:`Falha no diagnóstico da API: ${error.message}`, code:error.code || null });
  }
});



// Diagnóstico isolado do OpenRouter. Faz uma chamada mínima e NÃO envia dados da obra.
app.post('/api/ai-provider-test', async (_req,res) => {
  try {
    const result=await openRouterDiagnostics({probe:true});
    res.status(result.ok ? 200 : 502).json(result);
  } catch (error) {
    console.error('[AI PROVIDER TEST]', error);
    res.status(502).json({ok:false,error:error.message,details:error?.details || null});
  }
});

app.get('/api/database/stats', (_req,res) => {
  try { res.json({ ok:true, ...dbDiagnostics() }); }
  catch (error) { res.status(500).json({ error:`Falha ao consultar banco: ${error.message}` }); }
});

app.get('/api/syncs/latest', (req,res) => {
  try {
    const area = String(req.query.area || '').toUpperCase().trim();
    const obra = String(req.query.obra || '').trim();
    const projectBase = normalizeProjectBase(req.query.base || 'GO');
    if (!area || !obra) return res.status(400).json({error:'Informe area e obra.'});
    const project = findProject(area, obra, sourceModeForProjectBase(config.driveMode,projectBase));
    if (!project) return res.status(404).json({error:`Esta obra ainda não possui a base ${projectBase} no banco.`});
    const run = latestSyncForProject(project.id);
    if (!run) return res.status(404).json({error:'Nenhuma sincronização encontrada para esta obra.'});
    const snapshot=loadSnapshotFromDatabase(run.id);
    if (!getProjectDataset(snapshot.id) && snapshot.status !== 'processing') {
      try { saveProjectDataset({snapshot,projectId:project.id}); } catch (error) { console.warn('[PROJECT DATASET LAZY]',error.message); }
    }
    res.json(snapshot);
  } catch (error) { res.status(500).json({error:`Falha ao consultar última sincronização: ${error.message}`}); }
});


app.get('/api/project-bases/status', (req,res) => {
  try {
    const area=String(req.query.area || '').toUpperCase().trim();
    const obra=String(req.query.obra || '').trim();
    if(!area || !obra) return res.status(400).json({error:'Informe area e obra.'});
    const bases={};
    for(const projectBase of ['GO','GP']){
      const project=findProject(area,obra,sourceModeForProjectBase(config.driveMode,projectBase));
      const run=project ? latestSyncForProject(project.id) : null;
      bases[projectBase]={
        projectBase,
        configured:Boolean(project),
        projectId:project?.id || null,
        folderPath:project?.folder_path || null,
        expectedRelativePath:relativeCronogramaPath(area,projectBase,'/'),
        latestSync:run ? {id:run.id,status:run.status,startedAt:run.started_at,completedAt:run.completed_at,totalFiles:run.total_files,partialFiles:run.partial_files,failedFiles:run.failed_files} : null,
      };
    }
    res.json({area,obra,bases});
  } catch(error){ res.status(500).json({error:`Falha ao consultar bases do projeto: ${error.message}`}); }
});


// Janelas de atualização automática por obra/base. A configuração existe mesmo
// antes da primeira carga, permitindo que a primeira sincronização completa rode na janela escolhida.
app.get('/api/sync-schedules', (req,res) => {
  try {
    const area=String(req.query.area||'').toUpperCase().trim();
    const obra=String(req.query.obra||'').trim();
    const projectBase=normalizeProjectBase(req.query.base||'GO');
    if(!area||!obra) return res.status(400).json({error:'Informe area e obra.'});
    const schedule=getSyncSchedule(area,obra,projectBase) || {
      area,obra,projectBase,enabled:false,times:[],timezone:config.autoSync.timezone,onAnalysisRefresh:true,
      lastRunKey:null,lastJobId:null,lastStartedAt:null,lastCompletedAt:null,lastStatus:null,lastError:null,
    };
    res.json(schedule);
  } catch(error){res.status(500).json({error:`Falha ao consultar agenda: ${error.message}`});}
});

app.put('/api/sync-schedules', (req,res) => {
  try {
    const area=String(req.body?.area||'').toUpperCase().trim();
    const obra=String(req.body?.obra||'').trim();
    const projectBase=normalizeProjectBase(req.body?.base||'GO');
    if(!['RESIDENCIAL','CORPORATIVO','PREDIAL'].includes(area)) return res.status(400).json({error:'Área inválida.'});
    if(!obra) return res.status(400).json({error:'Informe a obra.'});
    const schedule=upsertSyncSchedule({
      area,obra,projectBase,enabled:Boolean(req.body?.enabled),times:req.body?.times||[],
      timezone:String(req.body?.timezone||config.autoSync.timezone),onAnalysisRefresh:req.body?.onAnalysisRefresh !== false,
    });
    res.json(schedule);
  } catch(error){res.status(400).json({error:error.message});}
});

app.post('/api/sync-schedules/run-now', (req,res) => {
  try{
    const area=String(req.body?.area||'').toUpperCase().trim();
    const obra=String(req.body?.obra||'').trim();
    const projectBase=normalizeProjectBase(req.body?.base||'GO');
    if(!area||!obra) return res.status(400).json({error:'Informe area e obra.'});
    const {job,deduplicated}=startIncrementalSync({area,obra,projectBase,trigger:'schedule_manual'});
    res.status(deduplicated?200:202).json({...job,deduplicated});
  }catch(error){res.status(500).json({error:`Falha ao iniciar atualização: ${error.message}`});}
});

app.get('/api/snapshots/:id/project-dataset', (req,res) => {
  try {
    const dataset=getProjectDataset(req.params.id);
    if (!dataset) return res.status(404).json({error:'Manifesto do projeto ainda não foi persistido. Abra/sincronize o projeto novamente.'});
    res.json(dataset);
  } catch (error) { res.status(500).json({error:`Falha ao consultar dataset do projeto: ${error.message}`}); }
});

app.get('/api/obras', async (_req,res) => {
  try {
    if (!['local','google'].includes(config.driveMode)) throw new Error(`DRIVE_MODE inválido: ${config.driveMode}. Use local ou google.`);
    const provider = await getProvider();
    const result = await provider.listObras();
    if (Array.isArray(result)) return res.json({ obras:result, warnings:[], source:config.driveMode });
    res.json({ obras:result.obras || [], warnings:result.warnings || [], source:config.driveMode });
  } catch (error) {
    console.error('[OBRAS]', error);
    res.status(500).json({ error:`Falha ao listar obras: ${error.message}`, code:error.code || null });
  }
});

// FASE 1: extração técnica. Esta rota nunca chama OpenRouter/IA.
app.post('/api/extractions', (req,res) => {
  const area = String(req.body?.area || '').toUpperCase().trim();
  const obra = String(req.body?.obra || '').trim();
  let projectBase;
  try { projectBase=normalizeProjectBase(req.body?.base || 'GO'); }
  catch (error) { return res.status(400).json({error:error.message}); }
  const retryPartial = Boolean(req.body?.retryPartial);
  if (!['RESIDENCIAL','CORPORATIVO','PREDIAL'].includes(area)) return res.status(400).json({error:'Área inválida.'});
  if (!obra) return res.status(400).json({error:'Informe a obra.'});
  const {job,deduplicated}=startIncrementalSync({area,obra,projectBase,retryPartial,trigger:'manual'});
  res.status(deduplicated?200:202).json({...job,deduplicated});
});

app.get('/api/extractions/:id', (req,res) => {
  const job = getJob(req.params.id);
  if (!job || job.kind !== 'extraction') return res.status(404).json({error:'Extração não encontrada.'});
  res.json(job);
});
app.get('/api/extractions/:id/events', (req,res) => streamJob(req,res,'extraction'));

app.get('/api/snapshots/:id', async (req,res) => {
  try { res.json(loadSnapshotFromDatabase(req.params.id)); }
  catch { res.status(404).json({error:'Snapshot não encontrado.'}); }
});

app.get('/api/snapshots/:id/files/:index', async (req,res) => {
  try {
    const snapshot = loadSnapshotFromDatabase(req.params.id);
    const index = Number(req.params.index);
    const file = snapshot.files[index];
    if (!file) return res.status(404).json({error:'Arquivo não encontrado no snapshot.'});
    if (!file.artifactKey) return res.status(409).json({error:'Este arquivo não possui artefato extraído.'});
    const artifact = loadArtifactFromDatabase(file.artifactId || file.artifactKey);
    const machineText = JSON.stringify(artifact.machine ?? {}, null, 2);
    res.json({
      file:{ name:file.name, relativePath:file.relativePath, ext:file.ext },
      artifact:{
        kind:artifact.kind, extractedBy:artifact.extractedBy, metrics:artifact.metrics || {},
        contentHash:artifact.contentHash, requiresVision:Boolean(artifact.requiresVision),
        ocr:artifact.ocr || null,
        technicalSummary:artifact.technicalSummary || null,
        coverage:artifact.coverage || artifact.analysisCorpus?.coverage || null,
        corpusStats:artifact.analysisCorpus?.stats || null,
        nativeTextPreview:String(artifact.nativeText || '').slice(0,18000),
        ocrTextPreview:String(artifact.ocrText || '').slice(0,18000),
        textPreview:String(artifact.text || '').slice(0,18000),
        machinePreview:machineText.slice(0,18000),
        previewTruncated:(artifact.text || '').length > 18000 || machineText.length > 18000,
      }
    });
  } catch (error) { res.status(500).json({error:`Falha ao abrir artefato: ${error.message}`}); }
});


function exportPayload(file, artifact) {
  return {
    schemaVersion:artifact.schemaVersion,
    source:file,
    kind:artifact.kind,
    extractedBy:artifact.extractedBy,
    extractedAt:artifact.extractedAt,
    extractorVersion:artifact.extractorVersion,
    contentHash:artifact.contentHash,
    metrics:artifact.metrics || {},
    coverage:artifact.coverage || artifact.analysisCorpus?.coverage || null,
    technicalSummary:artifact.technicalSummary || null,
    nativeText:artifact.nativeText || '',
    ocrText:artifact.ocrText || '',
    combinedText:artifact.text || '',
    machine:artifact.machine || {},
    ocr:artifact.ocr || null,
    embeddedMedia:(artifact.embeddedMedia || []).map(x => ({ name:x.name, ext:x.ext, mimeType:x.mimeType, bytes:x.bytes, ocr:x.ocr || null })),
    analysisCorpus:artifact.analysisCorpus || null,
  };
}


function safeZipSegment(value='arquivo') {
  return String(value || 'arquivo')
    .replace(/[<>:"|?*\x00-\x1F]/g,'_')
    .replace(/[. ]+$/g,'')
    .slice(0,180) || 'arquivo';
}

function artifactZipPath(file, index) {
  const raw = String(file.relativePath || file.name || `arquivo-${index+1}`).replaceAll('\\','/');
  const parts = raw.split('/').filter(Boolean).map(safeZipSegment);
  const leaf = parts.pop() || `arquivo-${index+1}`;
  const ordinal = String(index+1).padStart(4,'0');
  return ['json', ...parts, `${ordinal}__${leaf}.machine.json`].join('/');
}

app.get('/api/snapshots/:id/json-package', async (req,res) => {
  let archive = null;
  try {
    const snapshot = loadSnapshotFromDatabase(req.params.id);
    const manifest = {
      schemaVersion:2,
      generatedAt:new Date().toISOString(),
      application:'Tools analise de cronograma',
      snapshot:{
        id:snapshot.id, area:snapshot.area, obra:snapshot.obra, folder:snapshot.folder,
        createdAt:snapshot.createdAt, updatedAt:snapshot.updatedAt, status:snapshot.status, totals:snapshot.totals,
      },
      files:[],
    };

    const safe = `${snapshot.area}-${snapshot.obra}-${snapshot.id}`.replace(/[^a-z0-9_-]+/gi,'_').slice(0,140) || 'cronograma-jsons';
    res.status(200);
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="${safe}.jsons.zip"`);
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options','nosniff');

    archive = archiver('zip', { zlib:{ level:6 } });
    archive.on('warning', error => console.warn('[JSON PACKAGE WARNING]', error));
    archive.on('error', error => {
      console.error('[JSON PACKAGE]', error);
      if (!res.headersSent) res.status(500).json({error:`Falha ao gerar pacote JSON: ${error.message}`});
      else res.destroy(error);
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        try { archive?.abort(); } catch {}
      }
    });
    archive.pipe(res);

    let exported = 0;
    for (let i=0; i<snapshot.files.length; i++) {
      const file = snapshot.files[i];
      const row = {
        index:i,
        name:file.name,
        relativePath:file.relativePath || null,
        status:file.status || null,
        syncAction:file.syncAction || null,
        artifactId:file.artifactId || file.artifactKey || null,
        coverage:file.extraction?.coverage?.status || null,
        contentHash:file.extraction?.contentHash || null,
        error:file.error || null,
        exported:false,
        zipPath:null,
      };
      if (file.artifactKey) {
        try {
          const artifact = loadArtifactFromDatabase(file.artifactId || file.artifactKey);
          const zipPath = artifactZipPath(file,i);
          const payload = JSON.stringify(exportPayload(file,artifact), null, 2);
          archive.append(payload, { name:zipPath });
          row.exported = true;
          row.zipPath = zipPath;
          row.jsonBytes = Buffer.byteLength(payload);
          row.contentHash = artifact.contentHash || row.contentHash;
          row.coverage = artifact.coverage?.status || artifact.analysisCorpus?.coverage?.status || row.coverage;
          exported += 1;
        } catch (error) {
          row.exportError = error.message;
        }
      }
      manifest.files.push(row);
    }

    manifest.exportedJsonFiles = exported;
    manifest.totalSnapshotFiles = snapshot.files.length;
    archive.append(JSON.stringify(manifest,null,2), { name:'manifest.json' });
    archive.append([
      'TOOLS Análise de Cronograma - pacote de JSONs',
      `Obra: ${snapshot.obra} / ${snapshot.area}`,
      `Snapshot: ${snapshot.id}`,
      `JSONs exportados: ${exported}/${snapshot.files.length}`,
      '',
      'Cada arquivo em /json corresponde ao artefato machine-readable persistido no SQLite.',
      'O manifest.json informa status, caminho original, cobertura, hash e eventuais limitações.',
    ].join('\n'), { name:'LEIA-ME.txt' });

    await archive.finalize();
  } catch (error) {
    console.error('[JSON PACKAGE]', error);
    if (!res.headersSent) res.status(500).json({error:`Falha ao gerar pacote JSON: ${error.message}`});
    else if (!res.writableEnded) res.destroy(error);
  }
});


function downloadDisposition(filename='arquivo') {
  const raw = String(filename || 'arquivo');
  const ascii = raw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9._ -]/g,'_').replace(/[. ]+$/g,'').slice(0,140) || 'arquivo';
  const encoded = encodeURIComponent(raw).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

app.get('/api/snapshots/:id/files/:index/source', async (req,res) => {
  try {
    const snapshot = loadSnapshotFromDatabase(req.params.id);
    const index = Number(req.params.index);
    const file = snapshot.files[index];
    if (!file?.artifactKey) return res.status(404).json({error:'Arquivo não encontrado no snapshot.'});
    const artifact = loadArtifactFromDatabase(file.artifactId || file.artifactKey);
    if (!artifact.sourceBlobRef) return res.status(404).json({error:'Fonte original não preservada para este artefato.'});
    const stat = await fsp.stat(artifact.sourceBlobRef);
    if (!stat.isFile()) return res.status(404).json({error:'Fonte original preservada não é um arquivo válido.'});
    const safe = String(file.name || `arquivo-${index}`).replace(/[\\/:*?"<>|]/g,'_');
    res.setHeader('Content-Type',file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length',String(stat.size));
    res.setHeader('Content-Disposition',downloadDisposition(file.name || safe));
    res.setHeader('Cache-Control','no-store');
    const stream = fs.createReadStream(artifact.sourceBlobRef);
    stream.on('error', error => {
      console.error('[SOURCE DOWNLOAD]', error);
      if (!res.headersSent) res.status(500).json({error:`Falha ao baixar fonte original: ${error.message}`});
      else res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) { if (!res.headersSent) res.status(500).json({error:`Falha ao baixar fonte original: ${error.message}`}); }
});

app.get('/api/snapshots/:id/files/:index/export', async (req,res) => {
  try {
    const snapshot = loadSnapshotFromDatabase(req.params.id);
    const index = Number(req.params.index);
    const file = snapshot.files[index];
    if (!file?.artifactKey) return res.status(404).json({error:'Artefato não encontrado.'});
    const artifact = loadArtifactFromDatabase(file.artifactId || file.artifactKey);
    const format = String(req.query.format || 'json').toLowerCase();
    const safe = String(file.name || `arquivo-${index}`).replace(/[\\/:*?"<>|]/g,'_');
    if (format === 'txt') {
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      res.setHeader('Content-Disposition',downloadDisposition(`${safe}.machine.txt`));
      return res.send(artifact.analysisCorpus?.combinedText || artifact.text || '');
    }
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Content-Disposition',downloadDisposition(`${safe}.machine.json`));
    res.send(JSON.stringify(exportPayload(file,artifact),null,2));
  } catch (error) { res.status(500).json({error:`Falha ao exportar artefato: ${error.message}`}); }
});

app.get('/api/snapshots/:id/corpus', async (req,res) => {
  try {
    const snapshot = loadSnapshotFromDatabase(req.params.id);
    const format = String(req.query.format || 'json').toLowerCase();
    const safe = `${snapshot.area}-${snapshot.obra}-${snapshot.id}`.replace(/[^a-z0-9_-]+/gi,'_').slice(0,140) || 'cronograma-corpus';
    res.setHeader('Cache-Control','no-store');

    if (format === 'txt') {
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      res.setHeader('Content-Disposition',downloadDisposition(`${safe}.corpus.txt`));
      let exported = 0;
      for (let i=0; i<snapshot.files.length; i++) {
        const file = snapshot.files[i];
        if (!file.artifactKey) continue;
        const artifact = loadArtifactFromDatabase(file.artifactId || file.artifactKey);
        if (exported) res.write('\n\n==============================\n\n');
        res.write(`# DOCUMENTO ${i+1}: ${file.name}\nCAMINHO: ${file.relativePath || ''}\nCOBERTURA: ${artifact.coverage?.status || artifact.analysisCorpus?.coverage?.status || 'N/D'}\n\n`);
        res.write(artifact.analysisCorpus?.combinedText || artifact.text || '');
        exported += 1;
      }
      return res.end();
    }

    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Content-Disposition',downloadDisposition(`${safe}.corpus.json`));
    const snapshotHeader = {
      id:snapshot.id, area:snapshot.area, obra:snapshot.obra, folder:snapshot.folder,
      createdAt:snapshot.createdAt, updatedAt:snapshot.updatedAt, totals:snapshot.totals,
    };
    res.write(`{\n  "snapshot": ${JSON.stringify(snapshotHeader,null,2).replace(/\n/g,'\n  ')},\n  "files": [\n`);
    let exported = 0;
    for (let i=0; i<snapshot.files.length; i++) {
      const file = snapshot.files[i];
      if (!file.artifactKey) continue;
      const artifact = loadArtifactFromDatabase(file.artifactId || file.artifactKey);
      const payload = { processingStatus:file.status, processingError:file.error || null, ...exportPayload(file,artifact) };
      if (exported) res.write(',\n');
      const serialized = JSON.stringify(payload,null,2).split('\n').map(line => `    ${line}`).join('\n');
      res.write(serialized);
      exported += 1;
    }
    res.write('\n  ]\n}\n');
    res.end();
  } catch (error) {
    console.error('[CORPUS DOWNLOAD]', error);
    if (!res.headersSent) res.status(500).json({error:`Falha ao exportar corpus: ${error.message}`});
    else if (!res.writableEnded) res.destroy(error);
  }
});


// FASE 1.5: preparação canônica SEM IA. Mantém o JSON mestre no SQLite e cria
// uma projeção deduplicada, cálculos de cronograma, diff de versões e índice de evidências.
app.get('/api/default-prompt', async (_req,res) => {
  try {
    const promptPath = new URL('../prompts/PROMPT_Cronograma_HTML_Tools_R01_curto.md', import.meta.url);
    const prompt = await fsp.readFile(promptPath, 'utf8');
    res.json({ name:'PROMPT_Cronograma_HTML_Tools_R01_curto.md', prompt, locked:true, package:packageProfile() });
  } catch (error) { res.status(500).json({error:`Falha ao carregar prompt padrão: ${error.message}`}); }
});

app.post('/api/ai-preparations', (req,res) => {
  try {
    const snapshotId = String(req.body?.snapshotId || '').trim();
    if (!snapshotId) return res.status(400).json({error:'Informe snapshotId.'});
    const preparation = prepareSnapshotForAi(snapshotId);
    res.status(201).json(preparation);
  } catch (error) {
    console.error('[AI PREPARATION]', error);
    res.status(500).json({error:`Falha ao preparar dados para IA: ${error.message}`});
  }
});

app.get('/api/ai-preparations/:id', (req,res) => {
  try { res.json(loadPreparation(req.params.id)); }
  catch (error) { res.status(404).json({error:error.message}); }
});

app.get('/api/snapshots/:id/latest-ai-preparation', (req,res) => {
  try {
    const prep = latestPreparationForSnapshot(req.params.id);
    if (!prep) return res.status(404).json({error:'Nenhuma preparação para IA encontrada neste snapshot.'});
    res.json(prep);
  } catch (error) { res.status(500).json({error:`Falha ao consultar preparação: ${error.message}`}); }
});

app.get('/api/ai-preparations/:id/export', (req,res) => {
  try {
    const prep=loadPreparation(req.params.id);
    if (!prep.canonicalContext) return res.status(409).json({error:'Preparação desatualizada. Refaça Preparar para IA.'});
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Content-Disposition',downloadDisposition(`${prep.snapshotId}.contexto-canonico-ia.json`));
    // Este download é exatamente o JSON que será lido pela IA.
    res.send(JSON.stringify(prep.canonicalContext,null,2));
  } catch (error) { res.status(404).json({error:error.message}); }
});


// Chat: o usuário seleciona o projeto, o sistema recupera a base do SQLite,
// gera/reutiliza o Contexto canônico, faz a qualificação exigida pela skill e só então libera a IA.
app.post('/api/chat-sessions', (req,res) => {
  try {
    const snapshotId=String(req.body?.snapshotId || '').trim();
    if (!snapshotId) return res.status(400).json({error:'Informe snapshotId.'});
    const snapshot=loadSnapshotFromDatabase(snapshotId);
    if (snapshot.status === 'processing') return res.status(409).json({error:'A sincronização ainda está processando. Aguarde o fechamento da base antes de iniciar o chat.'});
    if (!snapshot.files?.some(f=>f.artifactKey)) return res.status(409).json({error:'O projeto ainda não possui JSONs disponíveis no banco.'});
    let prep=latestPreparationForSnapshot(snapshotId);
    if (!prep?.canonicalContext || !Array.isArray(prep.canonicalContext?.schedule?.availableVersions)) prep=prepareSnapshotForAi(snapshotId);
    const previousVersion=latestAnalysisVersion(snapshot.area,snapshot.obra,snapshot.projectBase || 'GO');
    const qualification=buildQualification(prep,{previousVersion});
    let carriedAnswers={};
    if(previousVersion?.chatSessionId){
      const previousSession=getChatSession(previousVersion.chatSessionId); const pa=previousSession?.state?.answers || {};
      for(const key of ['contractFinish','purpose','purposeDetail','stratification','milestones','milestoneHighlight']) if(pa[key]!==undefined) carriedAnswers[key]=pa[key];
    }
    const state={status:'qualification',qualification,answers:carriedAnswers,currentQuestion:0,parentVersionId:previousVersion?.id || null,analysisMode:previousVersion?'update':'initial'};
    const session=createChatSession({snapshotId,preparationId:prep.id,area:snapshot.area,obra:snapshot.obra,projectBase:snapshot.projectBase || 'GO',state});
    res.status(201).json({...session,project:{area:snapshot.area,obra:snapshot.obra,projectBase:snapshot.projectBase || 'GO',snapshotId,totals:snapshot.totals},preparation:{id:prep.id,stats:prep.stats,contract:prep.contract}});
  } catch (error) {
    console.error('[CHAT CREATE]',error);
    res.status(500).json({error:`Falha ao iniciar chat: ${error.message}`});
  }
});

app.get('/api/chat-sessions/:id', (req,res) => {
  const session=getChatSession(req.params.id);
  if (!session) return res.status(404).json({error:'Sessão de chat não encontrada.'});
  res.json(session);
});

app.get('/api/snapshots/:id/latest-chat-session', (req,res) => {
  let session=latestChatSessionForSnapshot(req.params.id);
  if(!session){ try{ const snapshot=loadSnapshotFromDatabase(req.params.id); session=latestChatSessionForProject(snapshot.area,snapshot.obra,snapshot.projectBase||'GO'); }catch{} }
  if (!session) return res.status(404).json({error:'Nenhuma sessão de chat encontrada para este projeto.'});
  res.json(session);
});

app.get('/api/projects/:area/:obra/:projectBase/analysis-versions', (req,res) => {
  try { res.json({items:listAnalysisVersions(req.params.area,req.params.obra,normalizeProjectBase(req.params.projectBase))}); }
  catch(error){ res.status(500).json({error:`Falha ao consultar versões: ${error.message}`}); }
});

app.get('/api/chat-sessions/:id/messages', (req,res) => {
  const session=getChatSession(req.params.id); if(!session) return res.status(404).json({error:'Sessão de chat não encontrada.'});
  res.json({items:listChatMessages(session.id)});
});

app.post('/api/chat-sessions/:id/followup', async (req,res) => {
  try {
    const session=getChatSession(req.params.id); if(!session) return res.status(404).json({error:'Sessão de chat não encontrada.'});
    const message=String(req.body?.message||'').trim(); if(!message) return res.status(400).json({error:'Digite a pergunta ou solicitação.'});
    if(!session.analysisId) return res.status(409).json({error:'Gere a primeira análise antes de usar o chat livre.'});
    addChatMessage(session.id,{role:'user',kind:'followup',content:message});
    const normalized=message.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    const wantsVersion=/(nova versao|nova analise|atualizar (a )?analise|atualizacao da analise|gerar outra|refazer analise|comparar (semana|periodo|versao)|novo relatorio|novo html)/.test(normalized);
    if(wantsVersion){
      const previousVersion=latestAnalysisVersion(session.area,session.obra,session.projectBase||'GO');
      let versionSnapshotId=session.snapshotId;
      try{ const project=findProject(session.area,session.obra,sourceModeForProjectBase(config.driveMode,session.projectBase||'GO')); const latest=project?latestSyncForProject(project.id):null; if(latest?.id) versionSnapshotId=latest.id; }catch{}
      let prep=latestPreparationForSnapshot(versionSnapshotId); if(!prep?.canonicalContext || !Array.isArray(prep.canonicalContext?.schedule?.availableVersions)) prep=prepareSnapshotForAi(versionSnapshotId);
      const qualification=buildQualification(prep,{previousVersion});
      let carriedAnswers={};
      if(previousVersion?.chatSessionId){ const previousSession=getChatSession(previousVersion.chatSessionId); const pa=previousSession?.state?.answers||{}; for(const key of ['contractFinish','purpose','purposeDetail','stratification','milestones','milestoneHighlight']) if(pa[key]!==undefined) carriedAnswers[key]=pa[key]; }
      const state={status:'qualification',qualification,answers:carriedAnswers,currentQuestion:0,parentVersionId:previousVersion?.id||null,analysisMode:'update',requestedFromFollowup:message};
      const next=createChatSession({snapshotId:versionSnapshotId,preparationId:prep.id,area:session.area,obra:session.obra,projectBase:session.projectBase||'GO',state});
      return res.status(201).json({type:'new_version',session:next,previousVersion});
    }
    const previousResult=await loadPreparedAiResult(session.analysisId);
    let prep=loadPreparation(session.preparationId);
    try{ const canonicalContext=await loadAnalysisContext(session.analysisId); prep={...prep,canonicalContext}; }catch{}
    const out=await answerAnalysisFollowup({question:message,previousResult,preparation:prep});
    addChatMessage(session.id,{role:'assistant',kind:'targeted_answer',content:out.answer,metadata:{targetedStats:out.targetedStats,model:out.model,provider:out.provider,usage:out.usage}});
    res.json({type:'answer',answer:out.answer,targetedStats:out.targetedStats,model:out.model,provider:out.provider,messages:listChatMessages(session.id)});
  } catch(error){ console.error('[CHAT FOLLOWUP]',error); res.status(500).json({error:`Falha no chat incremental: ${error.message}`}); }
});

app.post('/api/chat-sessions/:id/answer', (req,res) => {
  try {
    const session=getChatSession(req.params.id);
    if (!session) return res.status(404).json({error:'Sessão de chat não encontrada.'});
    if (['analyzing','completed'].includes(session.status)) return res.status(409).json({error:'Esta sessão já avançou para a análise. Inicie um novo chat para alterar as respostas.'});
    const questionId=String(req.body?.questionId || '').trim();
    if (!questionId) return res.status(400).json({error:'Informe questionId.'});
    const q=session.state?.qualification?.questions?.find(x=>x.id===questionId);
    if (!q) return res.status(400).json({error:'Pergunta inválida para esta sessão.'});
    const answers={...(session.state?.answers||{})};
    const value=req.body?.value;
    const emptyValue=Array.isArray(value) ? value.filter(Boolean).length===0 : (value == null || String(value).trim()==='');
    const comparisonCustom=questionId==='comparisonPeriods' ? String(req.body?.custom||'').trim() : '';
    if (q.required && emptyValue && !comparisonCustom) return res.status(400).json({error:'Esta pergunta precisa de resposta.'});
    if (questionId==='purpose' && String(value||'')==='Outro' && !String(req.body?.detail||'').trim()) return res.status(400).json({error:'Descreva a finalidade da análise.'});
    if (questionId==='milestones' && String(value||'')==='Ajustar / adicionar / destacar um marco' && !String(req.body?.highlight||'').trim()) return res.status(400).json({error:'Informe qual tema ou marco deve ser destacado.'});
    answers[questionId]=Array.isArray(value) ? value.map(x=>String(x).trim()).filter(Boolean) : (value == null ? '' : String(value).trim());
    if (questionId==='purpose' && req.body?.detail != null) answers.purposeDetail=String(req.body.detail).trim();
    if (questionId==='milestones' && req.body?.highlight != null) answers.milestoneHighlight=String(req.body.highlight).trim();
    if (questionId==='comparisonPeriods' && req.body?.custom != null) answers.comparisonCustom=String(req.body.custom).trim();
    const questions=session.state?.qualification?.questions || [];
    const answered=(id)=>id==='comparisonPeriods' ? ((Array.isArray(answers.comparisonPeriods)&&answers.comparisonPeriods.filter(Boolean).length>0)||String(answers.comparisonCustom||'').trim()!=='') : (Array.isArray(answers[id]) ? answers[id].filter(Boolean).length>0 : String(answers[id]??'').trim()!=='');
    let currentQuestion=questions.findIndex(x=>x.required && !answered(x.id));
    if (currentQuestion<0) currentQuestion=questions.findIndex(x=>!answered(x.id));
    if (currentQuestion<0) currentQuestion=questions.length;
    const nextState={...session.state,answers,currentQuestion};
    const ready=qualificationComplete(nextState);
    nextState.status=ready?'ready':'qualification';
    res.json(updateChatSession(session.id,{status:nextState.status,state:nextState}));
  } catch (error) { res.status(500).json({error:`Falha ao registrar resposta: ${error.message}`}); }
});

app.post('/api/chat-sessions/:id/analyze', (req,res) => {
  try {
    const session=getChatSession(req.params.id);
    if (!session) return res.status(404).json({error:'Sessão de chat não encontrada.'});
    if (!qualificationComplete(session.state)) return res.status(409).json({error:'Responda às perguntas da skill antes de gerar a análise.'});
    if (!config.openRouter.apiKey) return res.status(400).json({error:'OPENROUTER_API_KEY não configurada.'});
    const answers=session.state?.answers || {};
    const parentVersion=session.state?.parentVersionId ? getAnalysisVersion(session.state.parentVersionId) : latestAnalysisVersion(session.area,session.obra,session.projectBase||'GO');
    const version=createAnalysisVersion({area:session.area,obra:session.obra,projectBase:session.projectBase||'GO',parentVersionId:parentVersion?.id||null,chatSessionId:session.id,snapshotId:session.snapshotId,preparationId:session.preparationId,periodicity:String(answers.periodicity||''),comparison:Array.isArray(answers.comparisonPeriods)&&answers.comparisonPeriods.length?answers.comparisonPeriods:(answers.comparisonCustom?[String(answers.comparisonCustom)]:[])});
    const job=createJob({kind:'ai-analysis',snapshotId:session.snapshotId,preparationId:session.preparationId,chatSessionId:session.id,analysisVersionId:version.id,parentAnalysisVersionId:parentVersion?.id||null,preAnalysisSync:true});
    updateAnalysisVersion(version.id,{analysisId:job.id,status:'processing'});
    updateChatSession(session.id,{status:'analyzing',analysisId:job.id,state:{...session.state,status:'analyzing',analysisVersionId:version.id}});
    res.status(202).json({...job,analysisVersion:version});
    setImmediate(async()=>{
      try {
        let freshSession=getChatSession(session.id);
        if(config.autoSync.preAnalysisRefresh){
          updateJob(job.id,{status:'processing',progress:2,stage:`Verificando arquivos novos/alterados/removidos na base ${session.projectBase || 'GO'}…`});
          const schedule=getSyncSchedule(session.area,session.obra,session.projectBase||'GO');
          const refreshEnabled=schedule?.onAnalysisRefresh !== false;
          if(refreshEnabled){
            const {job:syncJob}=startIncrementalSync({area:session.area,obra:session.obra,projectBase:session.projectBase||'GO',trigger:'analysis_preflight'});
            updateJob(job.id,{progress:4,stage:'Sincronização incremental antes da análise em andamento…',freshnessSyncJobId:syncJob.id});
            const syncDone=await waitForJob(syncJob.id);
            if(syncDone.status==='failed') throw new Error(`Não foi possível atualizar a base antes da análise: ${syncDone.error || 'sincronização falhou'}`);
            const snapshotId=syncDone.result?.snapshotId || syncJob.id;
            updateJob(job.id,{progress:10,stage:'Base atualizada. Recriando Contexto canônico com o delta mais recente…',snapshotId});
            const prep=prepareSnapshotForAi(snapshotId);
            freshSession=updateChatSession(session.id,{snapshotId,preparationId:prep.id,status:'analyzing',analysisId:job.id,state:{...session.state,status:'analyzing',analysisVersionId:job.analysisVersionId}});
            job.snapshotId=snapshotId; job.preparationId=prep.id;
            if(job.analysisVersionId) updateAnalysisVersion(job.analysisVersionId,{snapshotId,preparationId:prep.id,delta:syncDone.syncDiff||null});
            updateJob(job.id,{snapshotId,preparationId:prep.id,freshness:{syncJobId:syncJob.id,syncStatus:syncDone.status,syncDiff:syncDone.syncDiff||null}});
          }
        }
        const {runAiAnalysis}=await import('./analysis/runAiAnalysis.js');
        await runAiAnalysis(job);
      }
      catch(error){ console.error('[CHAT AI BOOT]',error); updateChatSession(session.id,{status:'ready',state:{...session.state,status:'ready'}}); if(job.analysisVersionId) updateAnalysisVersion(job.analysisVersionId,{status:'failed'}); updateJob(job.id,{status:'failed',progress:100,stage:'Falha antes/durante a análise',error:error.message}); }
    });
  } catch (error) { res.status(500).json({error:`Falha ao iniciar análise do chat: ${error.message}`}); }
});

// FASE 2: IA. Exige snapshot pronto + Contexto canônico; o pacote TOOLS é bloqueado no servidor.
app.post('/api/ai-analyses', async (req,res) => {
  const snapshotId = String(req.body?.snapshotId || '').trim();
  const preparationId = String(req.body?.preparationId || '').trim();
  const chatSessionId = String(req.body?.chatSessionId || '').trim() || null;
  if (!snapshotId) return res.status(400).json({error:'Informe o snapshot da extração.'});
  if (!preparationId) return res.status(400).json({error:'Execute primeiro Preparar para IA para gerar o Contexto canônico para IA.'});
  if (!config.openRouter.apiKey) return res.status(400).json({error:'OPENROUTER_API_KEY não configurada. A Fase 1 funciona sem IA; configure a chave apenas para a Fase 2.'});
  try {
    const snapshot = loadSnapshotFromDatabase(snapshotId);
    if (snapshot.status === 'processing') return res.status(409).json({error:'A extração ainda está processando arquivos. Os JSONs já concluídos podem ser revisados, mas aguarde o encerramento de 100% das tentativas antes de iniciar a IA.'});
    if (!snapshot.files?.some(f => f.artifactKey)) return res.status(409).json({error:'O snapshot não possui nenhum JSON/artefato disponível para a IA.'});
  } catch (error) {
    return res.status(404).json({error:`Snapshot não encontrado: ${error.message}`});
  }
  try { const prep=loadPreparation(preparationId); if (prep.snapshotId !== snapshotId) return res.status(409).json({error:'A preparação não pertence a este snapshot.'}); } catch (error) { return res.status(404).json({error:`Preparação não encontrada: ${error.message}`}); }
  const job = createJob({ kind:'ai-analysis', snapshotId, preparationId, chatSessionId });
  res.status(202).json(job);
  setImmediate(async () => {
    try {
      const { runAiAnalysis } = await import('./analysis/runAiAnalysis.js');
      await runAiAnalysis(job);
    } catch (error) {
      console.error('[AI ANALYSIS BOOT]', error);
      updateJob(job.id, { status:'failed', progress:100, stage:'Falha ao iniciar IA', error:error.message });
    }
  });
});

app.get('/api/ai-analyses/:id', (req,res) => {
  const job = getJob(req.params.id);
  if (!job || job.kind !== 'ai-analysis') return res.status(404).json({error:'Análise IA não encontrada.'});
  res.json(job);
});
app.get('/api/ai-analyses/:id/result', async (req,res) => {
  try {
    const result=await loadPreparedAiResult(req.params.id);
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Content-Disposition',downloadDisposition(`${req.params.id}.resultado-preparado.json`));
    res.send(JSON.stringify(result,null,2));
  } catch (error) { res.status(404).json({error:error.message}); }
});

// O HTML não é escrito pela IA. Depois que o JSON preparado é validado,
// o backend executa o gerar_html.py + template EXATOS da skill anexada.
app.get('/api/ai-analyses/:id/html', async (req,res) => {
  try {
    const manifest=await loadRenderManifest(req.params.id);
    const file=manifest?.html?.path;
    if (!file || !fs.existsSync(file)) return res.status(404).json({error:'HTML TOOLS não encontrado para esta análise.'});
    const stat=await fsp.stat(file);
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Content-Length',String(stat.size));
    res.setHeader('Content-Disposition', req.query.download === '1' ? downloadDisposition(manifest.html.name) : `inline; filename="${String(manifest.html.name).replace(/["\r\n]/g,'_')}"`);
    res.setHeader('Cache-Control','no-store');
    fs.createReadStream(file).pipe(res);
  } catch (error) { res.status(404).json({error:error.message}); }
});

app.get('/api/ai-analyses/:id/render-manifest', async (req,res) => {
  try { res.json(await loadRenderManifest(req.params.id)); }
  catch (error) { res.status(404).json({error:error.message}); }
});

app.get('/api/ai-analyses/:id/output-file/:kind', async (req,res) => {
  try {
    const manifest=await loadRenderManifest(req.params.id);
    const allowed={data:manifest.data,csv:manifest.csv,config:manifest.config,raw:manifest.raw};
    const item=allowed[String(req.params.kind||'').toLowerCase()];
    if (!item?.path || !fs.existsSync(item.path)) return res.status(404).json({error:'Arquivo de saída não disponível para esta análise.'});
    const stat=await fsp.stat(item.path);
    const ext=String(item.name||'').toLowerCase();
    res.setHeader('Content-Type', ext.endsWith('.json') ? 'application/json; charset=utf-8' : ext.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/octet-stream');
    res.setHeader('Content-Length',String(stat.size));
    res.setHeader('Content-Disposition',downloadDisposition(item.name));
    res.setHeader('Cache-Control','no-store');
    fs.createReadStream(item.path).pipe(res);
  } catch (error) { res.status(404).json({error:error.message}); }
});

app.get('/api/ai-analyses/:id/output-package', async (req,res) => {
  try {
    const manifest=await loadRenderManifest(req.params.id);
    const nameBase=String(manifest?.html?.name || `${req.params.id}.html`).replace(/\.html$/i,'');
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',downloadDisposition(`${nameBase}_pacote.zip`));
    res.setHeader('Cache-Control','no-store');
    const archive=archiver('zip',{zlib:{level:6}});
    archive.on('error',err=>{ if (!res.headersSent) res.status(500).json({error:err.message}); else res.destroy(err); });
    archive.pipe(res);
    for (const item of [manifest.html,manifest.data,manifest.csv,manifest.config,manifest.raw,manifest.preparedResult]) {
      if (item?.path && fs.existsSync(item.path)) archive.file(item.path,{name:item.name});
    }
    const manifestFile=await loadRenderManifest(req.params.id);
    archive.append(JSON.stringify(manifestFile,null,2),{name:'render-manifest.json'});
    await archive.finalize();
  } catch (error) {
    console.error('[AI OUTPUT PACKAGE]',error);
    if (!res.headersSent) res.status(404).json({error:error.message}); else if (!res.writableEnded) res.destroy(error);
  }
});
app.get('/api/ai-analyses/:id/events', (req,res) => streamJob(req,res,'ai-analysis'));

// Evita que clientes antigos das versões anteriores executem IA automaticamente por engano.
app.post('/api/analyses', (_req,res) => res.status(410).json({
  error:'Endpoint legado desativado. Use primeiro /api/extractions (sem IA) e somente depois /api/ai-analyses.'
}));

function streamJob(req,res,kind) {
  const job = getJob(req.params.id);
  if (!job || job.kind !== kind) return res.status(404).end();
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders?.();
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(job);
  const unsubscribe = subscribe(req.params.id, send);
  const heartbeat = setInterval(()=>res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
}

// Produção/Render: quando client/dist existir, a própria API serve o React.
// Assim frontend e backend usam o mesmo domínio e VITE_API_URL pode permanecer vazio.
const clientDist = path.resolve(config.serverRoot, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index:false, maxAge:'1h' }));
  app.use((req,res,next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err,_req,res,_next) => {
  console.error('[EXPRESS]', err);
  res.status(500).json({error:err.message || 'Erro interno.'});
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log('');
  console.log(`Tools analise de cronograma · API http://localhost:${config.port}`);
  console.log(`DRIVE_MODE=${config.driveMode}`);
  console.log('FASE 1=sincronizacao incremental SQLite + JSON/OCR persistente SEM IA generativa');
  console.log('FASE 1.5=Preparar para IA: JSON canonico + calculos + diff + indice de evidencias SEM IA');
  console.log(`FASE 2=IA ${config.openRouter.apiKey ? 'configurada' : 'NAO configurada'} · modelo=${config.openRouter.model}`);
  console.log(`ENV=${config.envPath}`);
  console.log(`Diagnostico: http://localhost:${config.port}/api/health`);
  console.log(`AUTO_SYNC=${config.autoSync.enabled ? 'ativo' : 'desativado'} · timezone=${config.autoSync.timezone} · poll=${config.autoSync.pollSeconds}s`);
  startAutoSyncScheduler();
  console.log('');
});

server.on('error', error => {
  if (error?.code === 'EADDRINUSE') console.error(`[FATAL] A porta ${config.port} ja esta em uso.`);
  else console.error('[FATAL] Falha ao iniciar API:', error);
  process.exitCode = 1;
});
