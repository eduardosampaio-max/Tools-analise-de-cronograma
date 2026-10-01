import { config } from '../config.js';

let workerPromise = null;
let ocrQueue = Promise.resolve();
let progressReporter = null;

export function setOcrProgressReporter(fn) { progressReporter = typeof fn === 'function' ? fn : null; }
function reportProgress(payload) { try { progressReporter?.(payload); } catch {} }

function clean(text='') {
  return String(text || '').replace(/\u0000/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

function errorText(error) { return error?.message || String(error || 'Erro desconhecido'); }

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function resetWorker() {
  const pending = workerPromise;
  workerPromise = null;
  if (!pending) return;
  try {
    const worker = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('worker init timeout')), 1500)),
    ]);
    if (worker?.terminate) {
      await Promise.race([
        Promise.resolve(worker.terminate()),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ]);
    }
  } catch {}
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} excedeu ${Math.round(ms/1000)}s e foi interrompido para não travar a extração.`);
          error.code = 'OCR_TIMEOUT';
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function langsValue() {
  const raw = String(config.ocr.languages || 'por+eng').trim();
  const parts = raw.split(/[+,;]/).map(x => x.trim()).filter(Boolean);
  return parts.length <= 1 ? (parts[0] || 'por') : parts;
}

async function getWorker() {
  if (!config.ocr.enabled) throw new Error('OCR desabilitado por configuração.');
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker(langsValue(), undefined, {
        logger: message => {
          if (message?.status) {
            const pct = Number(message.progress || 0) * 100;
            reportProgress({ phase:'ocr_engine', status:message.status, progress:Number.isFinite(pct) ? Math.round(pct) : null });
            if (process.env.OCR_LOG === '1') {
              console.log(`[OCR] ${message.status}${Number.isFinite(pct) ? ` ${pct.toFixed(0)}%` : ''}`);
            }
          }
        },
      });
    })().catch(error => { workerPromise = null; throw error; });
  }
  return workerPromise;
}

async function lockedRecognize(buffer, label='imagem', attempt=1) {
  const run = async () => {
    reportProgress({ phase:'ocr_image_start', label, attempt, maxAttempts:config.ocr.retryAttempts });
    const worker = await getWorker();
    try {
      const result = await withTimeout(worker.recognize(buffer), config.ocr.timeoutMs, `OCR de ${label}`);
      reportProgress({ phase:'ocr_image_done', label, attempt, maxAttempts:config.ocr.retryAttempts });
      return {
        text: clean(result?.data?.text || ''),
        confidence: Number.isFinite(result?.data?.confidence) ? Math.round(result.data.confidence * 10) / 10 : null,
      };
    } catch (error) {
      // Depois de qualquer falha descartamos o worker. Alguns erros do Tesseract deixam
      // o worker vivo, porém inutilizável para a próxima página.
      await resetWorker();
      throw error;
    }
  };
  const current = ocrQueue.then(run, run);
  ocrQueue = current.then(() => undefined, () => undefined);
  return current;
}

export async function ocrImage(buffer, label='imagem') {
  if (!config.ocr.enabled) return { applied:false, skipped:true, eligible:true, reason:'OCR desabilitado', text:'', confidence:null, attempts:0 };
  if (!buffer?.length) return { applied:false, skipped:true, eligible:false, reason:'Imagem vazia', text:'', confidence:null, attempts:0 };
  if (buffer.length > config.ocr.maxImageBytes) {
    return { applied:false, skipped:true, eligible:true, reason:`${label} excede o limite OCR de ${Math.round(config.ocr.maxImageBytes/1024/1024)} MB`, text:'', confidence:null, attempts:0 };
  }

  const errors = [];
  const attempts = Math.max(1, Number(config.ocr.retryAttempts || 1));
  for (let attempt=1; attempt<=attempts; attempt++) {
    try {
      if (attempt > 1) {
        reportProgress({ phase:'ocr_retry', label, attempt, maxAttempts:attempts });
        await sleep(Math.min(1500, 250 * attempt));
      }
      const recognized = await lockedRecognize(buffer, label, attempt);
      return {
        applied:true, skipped:false, eligible:true, engine:'Tesseract.js', languages:config.ocr.languages,
        attempts:attempt, retryErrors:errors, ...recognized,
      };
    } catch (error) {
      errors.push(errorText(error));
    }
  }
  return {
    applied:false, skipped:false, eligible:true, engine:'Tesseract.js', languages:config.ocr.languages,
    error:errors.at(-1) || 'OCR não concluído', retryErrors:errors, attempts, text:'', confidence:null,
  };
}

async function renderPdfPage(page, scale) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  const context = canvas.getContext('2d');
  await page.render({ canvasContext:context, viewport }).promise;
  if (typeof canvas.toBuffer === 'function') return canvas.toBuffer('image/png');
  return canvas.encode('png');
}

function pageScales() {
  const values = [Number(config.ocr.pdfScale || 1.8), Number(config.ocr.retryScale || 1.35), 1.0];
  return [...new Set(values.filter(x => Number.isFinite(x) && x >= 1))];
}

async function ocrPdfPage(document, pageNo, totalPages) {
  const scales = pageScales();
  const errors = [];
  for (let attempt=0; attempt<scales.length; attempt++) {
    const scale = scales[attempt];
    reportProgress({ phase:'ocr_pdf_page', page:pageNo, totalPages, attempt:attempt+1, maxAttempts:scales.length, scale });
    try {
      const page = await document.getPage(pageNo);
      const png = await renderPdfPage(page, scale);
      const recognized = await ocrImage(png, `página ${pageNo}`);
      if (recognized.applied) {
        return { page:pageNo, scale, renderAttempts:attempt+1, renderErrors:errors, ...recognized };
      }
      errors.push(recognized.error || recognized.reason || `OCR sem sucesso na escala ${scale}`);
      // Se Tesseract falhou em todas as tentativas nessa imagem, renderizamos de novo em escala menor.
    } catch (error) {
      errors.push(errorText(error));
      await resetWorker();
    }
  }
  return {
    page:pageNo, applied:false, skipped:false, eligible:true, text:'', confidence:null,
    error:errors.at(-1) || 'Página não concluiu OCR após novas tentativas.', retryErrors:errors,
    attempts:errors.length,
  };
}

export async function ocrPdf(buffer, { nativeTextLength=0, pagesHint=null } = {}) {
  const mode = config.ocr.pdfMode;
  if (!config.ocr.enabled || mode === 'off') {
    return { applied:false, skipped:true, eligible:true, reason:!config.ocr.enabled ? 'OCR desabilitado' : 'OCR de PDF desabilitado', pages:[], text:'', complete:false };
  }
  const estimatedPages = Math.max(1, Number(pagesHint) || 1);
  const nativePerPage = nativeTextLength / estimatedPages;
  if (mode === 'auto' && nativePerPage >= config.ocr.pdfNativeCharsPerPage) {
    return {
      applied:false, skipped:true, eligible:true,
      reason:`PDF já possui camada de texto suficiente (${Math.round(nativePerPage)} caracteres/página).`,
      pages:[], text:'', nativeTextSufficient:true, complete:true,
    };
  }

  let document;
  try {
    const canvasModule = await import('@napi-rs/canvas');
    if (!globalThis.DOMMatrix && canvasModule.DOMMatrix) globalThis.DOMMatrix = canvasModule.DOMMatrix;
    if (!globalThis.ImageData && canvasModule.ImageData) globalThis.ImageData = canvasModule.ImageData;
    if (!globalThis.Path2D && canvasModule.Path2D) globalThis.Path2D = canvasModule.Path2D;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({ data:new Uint8Array(buffer), disableWorker:true, useSystemFonts:true });
    document = await loadingTask.promise;
    const totalPages = document.numPages;
    const configuredMax = Number(config.ocr.pdfMaxPages || 0);
    const maxPages = configuredMax > 0 ? Math.min(totalPages, configuredMax) : totalPages;
    const pages = [];
    const combined = [];

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const recognized = await ocrPdfPage(document, pageNo, maxPages);
      pages.push(recognized);
      if (recognized.text) combined.push(`### OCR PÁGINA ${pageNo}\n${recognized.text}`);
    }

    const failedPages = pages.filter(p => !p.applied && !p.skipped);
    const appliedPages = pages.filter(p => p.applied);
    return {
      applied:appliedPages.length > 0,
      skipped:false,
      eligible:true,
      complete:failedPages.length === 0 && totalPages <= maxPages,
      engine:'PDF.js + Tesseract.js',
      totalPages,
      processedPages:maxPages,
      successfulPages:appliedPages.length,
      failedPages:failedPages.length,
      failedPageNumbers:failedPages.map(p => p.page),
      truncated:totalPages > maxPages,
      pages,
      text:clean(combined.join('\n\n')),
    };
  } catch (error) {
    return { applied:false, skipped:false, eligible:true, complete:false, engine:'PDF.js + Tesseract.js', error:errorText(error), pages:[], text:'' };
  } finally {
    try { await document?.destroy?.(); } catch {}
  }
}

export async function enrichExtractionWithOcr({ file, buffer, extracted }) {
  extracted.nativeText = clean(extracted.text || '');
  extracted.ocrText = '';

  const embedded = Array.isArray(extracted.sidecars) ? extracted.sidecars : [];
  const eligible = extracted.kind === 'image' || extracted.kind === 'pdf' || embedded.length > 0;
  const targetCount = (extracted.kind === 'image' ? 1 : 0) + embedded.length + (extracted.kind === 'pdf' ? Math.max(1, Number(extracted.metrics?.pages || 1)) : 0);

  if (!config.ocr.enabled) {
    extracted.ocr = { enabled:false, eligible, notApplicable:!eligible, applied:false, complete:!eligible, targetCount, note:'OCR desabilitado por OCR_ENABLED=false.' };
    return extracted;
  }

  if (!eligible) {
    extracted.ocr = {
      enabled:true, eligible:false, notApplicable:true, applied:false, complete:true,
      targetCount:0, completedTargets:0, failedTargets:0, characters:0,
      note:'OCR não aplicável: o arquivo não possui conteúdo visual elegível detectado. A extração nativa/estruturada é a fonte principal.',
    };
    return extracted;
  }

  const ocrParts = [];
  const ocrInfo = {
    enabled:true, eligible:true, notApplicable:false, engine:'Tesseract.js', languages:config.ocr.languages,
    images:[], pdf:null, targetCount, completedTargets:0, failedTargets:0,
  };

  if (extracted.kind === 'image') {
    const result = await ocrImage(buffer, file.name);
    ocrInfo.images.push({ source:'arquivo', name:file.name, ...result });
    extracted.machine.image.ocr = result;
    if (result.text) {
      ocrParts.push(`### OCR DA IMAGEM\n${result.text}`);
      extracted.extractedBy = 'Imagem original + OCR local (Tesseract.js)';
    }
  }

  if (extracted.kind === 'pdf') {
    const nativeTextLength = String(extracted.machine?.pdf?.nativeText ?? extracted.text ?? '').length;
    const result = await ocrPdf(buffer, { nativeTextLength, pagesHint:extracted.metrics?.pages });
    ocrInfo.pdf = result;
    extracted.machine.pdf.ocr = result;
    if (result.text) ocrParts.push(result.text);
  }

  if (embedded.length) {
    const configuredLimit = Number(config.ocr.maxEmbeddedImages || 0);
    const limit = configuredLimit > 0 ? Math.min(embedded.length, configuredLimit) : embedded.length;
    for (let i=0; i<limit; i++) {
      const media = embedded[i];
      reportProgress({ phase:'ocr_embedded', index:i+1, total:limit, label:media.name });
      const result = await ocrImage(media.buffer, media.name);
      media.ocr = result;
      ocrInfo.images.push({ source:'embutida', name:media.name, ...result });
      if (result.text) ocrParts.push(`### OCR IMAGEM EMBUTIDA: ${media.name}\n${result.text}`);
    }
    if (embedded.length > limit) ocrInfo.embeddedTruncated = embedded.length - limit;
  }

  const ocrText = clean(ocrParts.join('\n\n'));
  extracted.ocrText = ocrText;
  extracted.text = ocrText ? clean([extracted.nativeText, ocrText].filter(Boolean).join('\n\n')) : extracted.nativeText;

  const successfulImages = ocrInfo.images.filter(x => x.applied);
  const failedImages = ocrInfo.images.filter(x => x.eligible !== false && !x.applied && !x.skipped);
  const skippedRequiredImages = ocrInfo.images.filter(x => x.eligible !== false && !x.applied && x.skipped);
  const pdfSuccessful = Number(ocrInfo.pdf?.successfulPages || (ocrInfo.pdf?.pages || []).filter(p => p.applied).length || 0);
  const pdfFailed = Number(ocrInfo.pdf?.failedPages || (ocrInfo.pdf?.pages || []).filter(p => !p.applied && !p.skipped).length || 0);
  const intentionalSkipped = ocrInfo.pdf?.skipped ? 1 : 0;

  ocrInfo.completedTargets = successfulImages.length + pdfSuccessful;
  ocrInfo.failedTargets = failedImages.length + skippedRequiredImages.length + pdfFailed + Number(ocrInfo.embeddedTruncated || 0);
  ocrInfo.complete = ocrInfo.failedTargets === 0 && (!ocrInfo.pdf || ocrInfo.pdf.complete !== false || ocrInfo.pdf.skipped);
  ocrInfo.applied = successfulImages.length > 0 || Boolean(ocrInfo.pdf?.applied);
  ocrInfo.characters = ocrText.length;
  ocrInfo.intentionalSkipped = intentionalSkipped;

  extracted.metrics = {
    ...(extracted.metrics || {}),
    ocrImages:successfulImages.length,
    ocrPages:pdfSuccessful,
    ocrFailedImages:failedImages.length + skippedRequiredImages.length,
    ocrFailedPages:pdfFailed,
    ocrCharacters:ocrText.length,
  };
  extracted.ocr = ocrInfo;
  return extracted;
}

export async function getOcrDiagnostics() {
  if (!config.ocr.enabled) return { enabled:false, available:false, reason:'OCR_ENABLED=false' };
  try {
    await import('tesseract.js');
    await import('pdfjs-dist/legacy/build/pdf.mjs');
    await import('@napi-rs/canvas');
    return {
      enabled:true, available:true, engine:'Tesseract.js + PDF.js', languages:config.ocr.languages,
      pdfMode:config.ocr.pdfMode, pdfMaxPages:config.ocr.pdfMaxPages || 'todos',
      maxEmbeddedImages:config.ocr.maxEmbeddedImages || 'todas',
      timeoutSeconds:Math.round(config.ocr.timeoutMs/1000),
      retryAttempts:config.ocr.retryAttempts,
      retryScale:config.ocr.retryScale,
      requiredForVisual:config.ocr.requiredForVisual,
    };
  } catch (error) {
    return { enabled:true, available:false, engine:'Tesseract.js + PDF.js', error:error.message };
  }
}
