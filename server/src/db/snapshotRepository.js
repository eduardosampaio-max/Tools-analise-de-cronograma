import { getSyncRun, getSyncRunFiles, getProjectById, getArtifactSummary, loadArtifactRecord } from './database.js';
import { projectBaseFromSourceMode, driveModeFromProjectSourceMode } from '../domain/projectBase.js';

function parseSource(row) {
  try { return JSON.parse(row.source_json || '{}'); } catch { return {}; }
}

function extractionFromArtifactId(artifactId) {
  const summary = getArtifactSummary(artifactId);
  return summary?.public || null;
}

export function loadSnapshotFromDatabase(id) {
  const run = getSyncRun(id);
  if (!run) throw new Error(`Snapshot/sincronização ${id} não encontrado no banco.`);
  const project = getProjectById(run.project_id);
  const rows = getSyncRunFiles(id);
  const files = rows.map(row => {
    const source = parseSource(row);
    const extraction = row.artifact_id ? extractionFromArtifactId(row.artifact_id) : null;
    return {
      ...source,
      status:row.status,
      syncAction:row.action,
      previousRelativePath:row.previous_relative_path || null,
      cached:['reused','unchanged','renamed'].includes(row.status) || ['unchanged','renamed'].includes(row.action),
      artifactId:row.artifact_id || null,
      artifactKey:row.artifact_id || null, // compatibilidade temporária com o frontend/IA
      extraction,
      error:row.error || null,
    };
  });
  const artifacts = files.filter(f=>f.artifactId).length;
  const attempted = files.filter(f=>!['queued','processing'].includes(f.status)).length;
  const extracted = files.filter(f=>['extracted','reused','unchanged','renamed'].includes(f.status)).length;
  const partial = files.filter(f=>f.status==='partial').length;
  const failed = files.filter(f=>f.status==='failed').length;
  const completeCoverage = files.filter(f=>f.extraction?.coverage?.status==='complete').length;
  const partialCoverage = files.filter(f=>f.extraction?.coverage?.status==='partial').length;
  const corpusCharacters = files.reduce((s,f)=>s+Number(f.extraction?.corpusStats?.combinedCharacters||0),0);
  const nativeCharacters = files.reduce((s,f)=>s+Number(f.extraction?.corpusStats?.nativeCharacters||0),0);
  const ocrCharacters = files.reduce((s,f)=>s+Number(f.extraction?.corpusStats?.ocrCharacters||0),0);
  const machineJsonCharacters = files.reduce((s,f)=>s+Number(f.extraction?.corpusStats?.machineJsonCharacters||0),0);
  return {
    id:run.id,
    schemaVersion:6,
    extractorVersion:files.find(f=>f.extraction)?.extraction?.extractorVersion || null,
    status:run.status,
    area:project?.area,
    obra:project?.obra,
    folder:{ path:project?.folder_path, source:driveModeFromProjectSourceMode(project?.source_mode), projectBase:projectBaseFromSourceMode(project?.source_mode), pathMode:'fixed' },
    createdAt:run.started_at,
    updatedAt:run.updated_at,
    aiUsed:false,
    sourceMode:driveModeFromProjectSourceMode(project?.source_mode),
    projectBase:projectBaseFromSourceMode(project?.source_mode),
    databaseBacked:true,
    totals:{
      files:run.total_files,
      attempted,
      pending:Math.max(0,run.total_files-attempted),
      extracted,partial,failed,artifacts,
      cached:run.unchanged_files+run.renamed_files+run.reused_artifacts,
      bytes:run.bytes_scanned,
      completeCoverage,partialCoverage,corpusCharacters,nativeCharacters,ocrCharacters,machineJsonCharacters,
      newFiles:run.new_files,
      modifiedFiles:run.modified_files,
      retryFiles:run.retry_files || 0,
      renamedFiles:run.renamed_files,
      unchangedFiles:run.unchanged_files,
      deletedFiles:run.deleted_files,
      reusedArtifacts:run.reused_artifacts,
      processedFiles:run.processed_files,
    },
    files,
  };
}

export function loadArtifactFromDatabase(artifactId) {
  return loadArtifactRecord(artifactId);
}
