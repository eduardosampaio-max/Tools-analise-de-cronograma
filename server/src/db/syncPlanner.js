import { getActiveFiles, createOrUpdateFile, markFileDeleted, touchFile, addRunFile } from './database.js';

function sameMeta(a,b) {
  return Number(a.size || 0) === Number(b.size || 0) && String(a.modified_time || '') === String(b.modifiedTime || '');
}

function normPath(v='') { return String(v).replaceAll('\\','/').toLowerCase(); }
function shouldAutoRetryPartial(record) {
  if (record?.status !== 'partial') return false;
  const text = String(record?.error || '').toLowerCase();
  return [
    'enoent','no such file or directory','source_not_found_after_retry','arquivo inventariado não estava mais disponível',
    'ocr','página(s) do pdf','pagina(s) do pdf','mídia(s) embutida','midia(s) embutida',
    'worker_idle_timeout','worker_hard_timeout','processamento complementar interrompido','tesseract','pdf.js'
  ].some(token => text.includes(token));
}

export function planSync({ projectId, runId, files, extractorVersion, compatibleExtractorVersions=[], retryPartial=false }) {
  const compatibleVersions = new Set([extractorVersion, ...compatibleExtractorVersions]);
  const existing = getActiveFiles(projectId);
  const byPath = new Map(existing.map(x => [normPath(x.relative_path), x]));
  const byStable = new Map(existing.filter(x => x.stable_id).map(x => [x.stable_id, x]));
  const matchedExisting = new Set();
  const unmatchedCurrent = [];
  const plan = new Array(files.length);

  // 1) caminho exato ou identidade estável (rename real quando disponível)
  files.forEach((file, index) => {
    let record = byPath.get(normPath(file.relativePath));
    let action = null;
    let previousRelativePath = null;

    if (record) {
      matchedExisting.add(record.id);
      const artifactCurrent = Boolean(record.artifact_id && compatibleVersions.has(record.extractor_version));
      const autoRetrySource = shouldAutoRetryPartial(record);
      if (sameMeta(record,file) && artifactCurrent && (autoRetrySource || (retryPartial && record.status === 'partial'))) action = 'retry_partial';
      else if (sameMeta(record,file) && artifactCurrent) action = 'unchanged';
      else action = 'modified';
    } else if (file.stableId && byStable.has(file.stableId)) {
      record = byStable.get(file.stableId);
      if (!matchedExisting.has(record.id)) {
        matchedExisting.add(record.id);
        previousRelativePath = record.relative_path;
        const artifactCurrent = Boolean(record.artifact_id && compatibleVersions.has(record.extractor_version));
        const autoRetrySource = shouldAutoRetryPartial(record);
        if (sameMeta(record,file) && artifactCurrent && (autoRetrySource || (retryPartial && record.status === 'partial'))) action = 'retry_partial';
        else if (sameMeta(record,file) && artifactCurrent) action = 'renamed';
        else action = 'renamed_modified';
      } else record = null;
    }

    if (record) {
      const updated = createOrUpdateFile(projectId, file, { recordId:record.id, status:action === 'unchanged' || action === 'renamed' ? record.status : 'queued' });
      if (action === 'unchanged' || action === 'renamed') touchFile(updated.id,file);
      plan[index] = { file, index, fileRecord:updated, action, previousRelativePath, needsProcessing:!['unchanged','renamed'].includes(action), artifactId:['unchanged','renamed'].includes(action) ? record.artifact_id : null };
      return;
    }
    unmatchedCurrent.push({file,index});
  });

  // 2) fallback de rename: mesmo tamanho + modifiedTime e candidato único desaparecido.
  const candidates = existing.filter(x => !matchedExisting.has(x.id));
  for (const current of unmatchedCurrent) {
    const { file, index } = current;
    const hits = candidates.filter(x => !matchedExisting.has(x.id) && sameMeta(x,file) && String(x.ext || '').toLowerCase() === String(file.ext || '').toLowerCase());
    if (hits.length === 1 && hits[0].artifact_id && compatibleVersions.has(hits[0].extractor_version)) {
      const record = hits[0];
      matchedExisting.add(record.id);
      const previousRelativePath = record.relative_path;
      const autoRetrySource = shouldAutoRetryPartial(record);
      const updated = createOrUpdateFile(projectId, file, { recordId:record.id, status:autoRetrySource ? 'queued' : record.status });
      if (!autoRetrySource) touchFile(updated.id,file);
      plan[index] = autoRetrySource
        ? { file,index,fileRecord:updated,action:'retry_partial',previousRelativePath,needsProcessing:true,artifactId:null }
        : { file,index,fileRecord:updated,action:'renamed',previousRelativePath,needsProcessing:false,artifactId:record.artifact_id };
    } else {
      const created = createOrUpdateFile(projectId,file,{status:'queued'});
      matchedExisting.add(created.id);
      plan[index] = { file,index,fileRecord:created,action:'new',previousRelativePath:null,needsProcessing:true,artifactId:null };
    }
  }

  const deleted = existing.filter(x => !matchedExisting.has(x.id));
  for (const record of deleted) markFileDeleted(record.id);

  for (const item of plan) {
    addRunFile({
      runId, fileId:item.fileRecord.id, ordinal:item.index, action:item.action, status:item.needsProcessing ? 'queued' : 'reused',
      previousRelativePath:item.previousRelativePath, artifactId:item.artifactId, error:null, source:item.file,
    });
  }

  return { plan, deleted, counts:{
    new:plan.filter(x=>x.action==='new').length,
    modified:plan.filter(x=>x.action==='modified' || x.action==='renamed_modified').length,
    retry:plan.filter(x=>x.action==='retry_partial').length,
    renamed:plan.filter(x=>x.action==='renamed' || x.action==='renamed_modified').length,
    unchanged:plan.filter(x=>x.action==='unchanged').length,
    deleted:deleted.length,
    toProcess:plan.filter(x=>x.needsProcessing).length,
    reusedMetadata:plan.filter(x=>!x.needsProcessing).length,
  }};
}
