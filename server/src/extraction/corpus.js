import { config } from '../config.js';

function text(value='') { return String(value ?? ''); }
function json(value) { try { return JSON.stringify(value ?? {}, null, 2); } catch { return '{}'; } }

function coverageStatus(extracted) {
  const limitations = [];
  const strictOcr = config.ocr.requiredForVisual !== false;
  if (extracted.kind === 'binary') limitations.push('Formato sem extrator estruturado específico; o arquivo original foi preservado integralmente.');
  if ((extracted.kind === 'image' || extracted.kind === 'pdf') && !extracted.ocr?.enabled) limitations.push('OCR desabilitado para um formato com conteúdo visual.');
  if (strictOcr && extracted.kind === 'image' && extracted.ocr?.enabled && !extracted.ocr?.images?.some(x => x.applied)) limitations.push('A imagem não teve OCR concluído com sucesso.');
  if (strictOcr && extracted.kind === 'pdf' && extracted.ocr?.enabled && extracted.ocr?.pdf && !extracted.ocr.pdf.applied && !extracted.ocr.pdf.skipped) limitations.push('O PDF não teve OCR concluído com sucesso.');
  const pdfPages = extracted.ocr?.pdf?.pages || [];
  const pdfSkipped = pdfPages.filter(p => p?.skipped || p?.error);
  if (strictOcr && pdfSkipped.length) limitations.push(`${pdfSkipped.length} página(s) do PDF não concluíram OCR integral.`);
  const embeddedSkipped = (extracted.ocr?.images || []).filter(x => x?.source === 'embutida' && (x?.skipped || x?.error));
  if (strictOcr && embeddedSkipped.length) limitations.push(`${embeddedSkipped.length} mídia(s) embutida(s) não concluíram OCR integral.`);
  if (strictOcr && extracted.ocr?.pdf?.truncated) limitations.push(`OCR do PDF limitado a ${extracted.ocr.pdf.processedPages}/${extracted.ocr.pdf.totalPages} páginas.`);
  if (strictOcr && extracted.ocr?.embeddedTruncated) limitations.push(`${extracted.ocr.embeddedTruncated} mídia(s) embutida(s) não passaram por OCR por limite configurado.`);
  const ocrErrors = [
    ...(extracted.ocr?.images || []).map(x => x?.error).filter(Boolean),
    extracted.ocr?.pdf?.error,
  ].filter(Boolean);
  if (strictOcr && ocrErrors.length) limitations.push(...ocrErrors.map(x => `OCR: ${x}`));
  if (Array.isArray(extracted.limitations)) limitations.push(...extracted.limitations.filter(Boolean));
  return {
    status: limitations.length ? 'partial' : 'complete',
    sourcePreserved: true,
    nativeStructuredExtraction: extracted.kind !== 'binary',
    ocrEnabled: Boolean(extracted.ocr?.enabled),
    ocrApplied: Boolean(extracted.ocr?.applied),
    limitations,
  };
}

export function buildAnalysisCorpus(extracted) {
  const nativeText = text(extracted.nativeText ?? extracted.text ?? '');
  const ocrText = text(extracted.ocrText || '');
  const machineJson = json(extracted.machine || {});
  const sections = [];
  if (nativeText.trim()) sections.push({ id:'native-text', type:'native_text', label:'Texto nativo extraído', text:nativeText });
  if (ocrText.trim()) sections.push({ id:'ocr-text', type:'ocr_text', label:'Texto recuperado por OCR', text:ocrText });
  sections.push({ id:'machine-json', type:'machine_json', label:'Estrutura completa machine-readable', text:machineJson });

  const combinedText = sections.map(s => `### ${s.label}\n${s.text}`).join('\n\n');
  const coverage = coverageStatus(extracted);
  return {
    schemaVersion:1,
    coverage,
    sections,
    stats:{
      nativeCharacters:nativeText.length,
      ocrCharacters:ocrText.length,
      machineJsonCharacters:machineJson.length,
      combinedCharacters:combinedText.length,
      sections:sections.length,
    },
    combinedText,
  };
}
