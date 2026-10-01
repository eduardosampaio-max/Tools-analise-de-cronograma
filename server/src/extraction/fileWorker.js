import fs from 'node:fs/promises';
import { extractFileNative, extractionNeedsOcr, finalizeNativeArtifact, finalizeArtifactWithOcr } from '../extractors/index.js';
import { setOcrProgressReporter } from './ocr.js';
import { saveArtifact, saveBlob, publicArtifactInfo, EXTRACTOR_VERSION } from './snapshotStore.js';

function send(payload) {
  try {
    if (process.send) process.send(payload);
  } catch {}
}

function messageOf(error) {
  return error?.message || String(error || 'Erro desconhecido');
}

function applyCommonMetadata(artifact, { contentHash, sourceBlobRef }) {
  artifact.contentHash = contentHash;
  artifact.extractedAt = new Date().toISOString();
  artifact.extractorVersion = EXTRACTOR_VERSION;
  artifact.sourceBlobRef = sourceBlobRef;
  if (artifact.preserveBlob) artifact.blobRef = sourceBlobRef;
  delete artifact.preserveBlob;
  return artifact;
}

async function persistSidecars(artifactKey, native) {
  const sidecars = Array.isArray(native.sidecars) ? native.sidecars : [];
  if (!sidecars.length) return [];
  const embeddedMedia = [];
  for (let i = 0; i < sidecars.length; i++) {
    const media = sidecars[i];
    const blobRef = await saveBlob(`${artifactKey}-media-${i}`, media.ext || '.bin', media.buffer);
    embeddedMedia.push({
      name:media.name,
      ext:media.ext,
      mimeType:media.mimeType || null,
      bytes:media.buffer?.length || 0,
      blobRef,
      ocr:null,
    });
  }
  native.embeddedMedia = embeddedMedia;
  return embeddedMedia;
}

function sanitizedNative(native) {
  const out = { ...native };
  delete out.sidecars;
  return out;
}

function syncEmbeddedOcr(finalArtifact, native) {
  const sidecars = Array.isArray(native.sidecars) ? native.sidecars : [];
  const byName = new Map(sidecars.map(x => [x.name, x.ocr || null]));
  if (Array.isArray(finalArtifact.embeddedMedia)) {
    finalArtifact.embeddedMedia = finalArtifact.embeddedMedia.map(x => ({ ...x, ocr:byName.get(x.name) || x.ocr || null }));
  }
  delete finalArtifact.sidecars;
}

async function run(payload) {
  const { file, artifactKey, sourceBlobRef, contentHash } = payload || {};
  let checkpointSaved = false;
  try {
    send({ type:'stage', phase:'worker_start', label:'Processo isolado iniciado' });
    const buffer = await fs.readFile(sourceBlobRef);

    send({ type:'stage', phase:'native_start', label:'Extração nativa/estruturada' });
    const native = await extractFileNative(file, buffer);
    await persistSidecars(artifactKey, native);

    const needsOcr = extractionNeedsOcr(native);
    let checkpoint = finalizeNativeArtifact(file, sanitizedNative(native), {
      ocrPending:needsOcr,
      ocrNote:needsOcr
        ? 'Extração nativa concluída e salva. OCR sendo executado em processo isolado.'
        : 'Extração nativa concluída; este arquivo não possui alvo de OCR adicional.',
    });
    checkpoint = applyCommonMetadata(checkpoint, { contentHash, sourceBlobRef });
    await saveArtifact(artifactKey, checkpoint);
    checkpointSaved = true;
    send({ type:'checkpoint', phase:'native_done', extraction:publicArtifactInfo(checkpoint), needsOcr });

    if (!needsOcr) {
      send({ type:'done', status:'extracted', extraction:publicArtifactInfo(checkpoint), checkpointSaved:true });
      return;
    }

    setOcrProgressReporter(progress => send({ type:'progress', ...progress }));
    send({ type:'stage', phase:'ocr_start', label:'OCR local' });

    let finalArtifact = await finalizeArtifactWithOcr(file, buffer, native);
    finalArtifact.embeddedMedia = native.embeddedMedia || finalArtifact.embeddedMedia || [];
    syncEmbeddedOcr(finalArtifact, native);
    finalArtifact = applyCommonMetadata(finalArtifact, { contentHash, sourceBlobRef });
    await saveArtifact(artifactKey, finalArtifact);
    send({ type:'done', status:finalArtifact.coverage?.status === 'partial' ? 'partial' : 'extracted', extraction:publicArtifactInfo(finalArtifact), checkpointSaved:true });
  } catch (error) {
    send({ type:'error', checkpointSaved, error:messageOf(error), code:error?.code || null });
  }
}

process.once('message', payload => {
  run(payload)
    .catch(error => send({ type:'error', checkpointSaved:false, error:messageOf(error), code:error?.code || null }))
    .finally(() => {
      // Tesseract/PDF/MPXJ podem manter handles internos. O processo por arquivo é descartável.
      setTimeout(() => process.exit(0), 25).unref?.();
    });
});

process.on('uncaughtException', error => {
  send({ type:'error', checkpointSaved:false, error:messageOf(error), code:error?.code || 'UNCAUGHT' });
  setTimeout(() => process.exit(1), 25).unref?.();
});
process.on('unhandledRejection', error => {
  send({ type:'error', checkpointSaved:false, error:messageOf(error), code:error?.code || 'UNHANDLED_REJECTION' });
  setTimeout(() => process.exit(1), 25).unref?.();
});
