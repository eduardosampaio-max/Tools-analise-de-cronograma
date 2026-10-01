import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { enrichExtractionWithOcr } from '../extraction/ocr.js';
import { buildTechnicalSummary } from '../extraction/technicalSummary.js';
import { buildAnalysisCorpus } from '../extraction/corpus.js';

const imageExts = new Set(['.png','.jpg','.jpeg','.webp','.bmp','.gif','.tif','.tiff']);
const textExts = new Set(['.txt','.md','.csv','.json','.log','.html','.htm','.yaml','.yml','.ini','.sql']);

function clean(text='') {
  return String(text ?? '').replace(/\u0000/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim();
}
function asArray(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function valueText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && '#text' in value) return String(value['#text']);
  return String(value);
}
function compact(obj) { return Object.fromEntries(Object.entries(obj || {}).filter(([,v]) => v !== undefined && v !== null && valueText(v) !== '')); }
function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (obj?.[key] !== undefined && obj?.[key] !== null && valueText(obj[key]) !== '') out[key] = obj[key];
  return out;
}
function mediaMime(ext='') {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  if (e === '.bmp') return 'image/bmp';
  if (e === '.tif' || e === '.tiff') return 'image/tiff';
  return 'image/jpeg';
}

async function collectOfficeArchive(buffer, rootPrefix) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const sidecars = [];
    const xmlParts = {};
    const vectorTextParts = {};
    const mediaInventory = [];
    const unsupportedMedia = [];
    const embeddedObjects = [];
    const entries = [];
    for (const name of Object.keys(zip.files).sort()) {
      const entry = zip.files[name];
      if (entry.dir) continue;
      entries.push(name);
      if (name.startsWith(`${rootPrefix}/embeddings/`)) {
        let bytes = 0;
        try { bytes = (await zip.file(name).async('nodebuffer')).length; } catch {}
        embeddedObjects.push({ name, ext:path.extname(name).toLowerCase(), bytes });
      }
      if (name.startsWith(`${rootPrefix}/media/`)) {
        const ext = path.extname(name).toLowerCase();
        const bytes = await zip.file(name).async('nodebuffer');
        mediaInventory.push({ name, ext, bytes:bytes.length, rasterOcrEligible:imageExts.has(ext) });
        if (imageExts.has(ext)) {
          sidecars.push({ name, ext, mimeType:mediaMime(ext), buffer:bytes });
        } else if (ext === '.svg') {
          const rawSvg = bytes.toString('utf8');
          vectorTextParts[name] = rawSvg;
        } else {
          unsupportedMedia.push({ name, ext, bytes:bytes.length });
        }
      }
      if (name.startsWith(`${rootPrefix}/`) && (/\.xml$/i.test(name) || /\.rels$/i.test(name))) {
        xmlParts[name] = await zip.file(name).async('string');
      }
    }
    return { sidecars, xmlParts, vectorTextParts, mediaInventory, unsupportedMedia, embeddedObjects, archiveEntries:entries };
  } catch {
    return { sidecars:[], xmlParts:{}, vectorTextParts:{}, mediaInventory:[], unsupportedMedia:[], embeddedObjects:[], archiveEntries:[] };
  }
}

function serializableCell(cell) {
  if (!cell) return null;
  return {
    type:cell.t ?? null,
    rawValue:cell.v ?? null,
    formattedValue:cell.w ?? null,
    formula:cell.f ?? null,
    numberFormat:cell.z ?? null,
    hyperlink:cell.l ?? null,
    comments:cell.c ?? null,
  };
}

async function excelToMachine(buffer) {
  const wb = XLSX.read(buffer, {
    type:'buffer', cellDates:true, cellFormula:true, cellNF:true, cellStyles:true,
    cellHTML:true, cellText:true, bookVBA:true, bookFiles:true,
  });
  const sheets = [];
  const text = [];
  let totalRows = 0;
  let totalCells = 0;
  let formulaCount = 0;
  let commentCount = 0;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:false, defval:null, blankrows:true });
    const cells = {};
    const formulas = [];
    for (const [address, cell] of Object.entries(ws)) {
      if (address.startsWith('!')) continue;
      totalCells += 1;
      const serialized = serializableCell(cell);
      cells[address] = serialized;
      if (cell?.f) {
        formulas.push({ cell:address, formula:cell.f, value:cell.w ?? cell.v ?? null });
        formulaCount += 1;
      }
      if (Array.isArray(cell?.c)) commentCount += cell.c.length;
    }
    totalRows += rows.length;
    const sheet = {
      name:sheetName,
      range:ws['!ref'] || null,
      rowCount:rows.length,
      rows,
      cells,
      formulas,
      merges:asArray(ws['!merges']).map(m => XLSX.utils.encode_range(m)),
      columns:ws['!cols'] || null,
      rowsMeta:ws['!rows'] || null,
      autoFilter:ws['!autofilter'] || null,
      margins:ws['!margins'] || null,
      protection:ws['!protect'] || null,
    };
    sheets.push(sheet);
    text.push(`### ABA: ${sheetName}`);
    rows.forEach((row,rowIndex) => text.push(`${rowIndex+1}: ${row.map(v => v == null ? '' : String(v).trim()).join(' | ')}`));
    if (formulas.length) {
      text.push('### FÓRMULAS');
      formulas.forEach(f => text.push(`${f.cell}: =${f.formula} => ${f.value ?? ''}`));
    }
  }

  const extras = await collectOfficeArchive(buffer, 'xl');
  const definedNames = asArray(wb.Workbook?.Names).map(x => ({ Name:x.Name, Ref:x.Ref, Sheet:x.Sheet ?? null, Comment:x.Comment ?? null }));
  return {
    kind:'spreadsheet', extractedBy:'SheetJS completo + pacote Office XML + OCR de mídias', text:clean(text.join('\n')),
    machine:{ workbook:{
      sheetNames:wb.SheetNames,
      sheets,
      workbookProps:wb.Workbook || null,
      properties:wb.Props || null,
      customProperties:wb.Custprops || null,
      definedNames,
      hasVba:Boolean(wb.vbaraw),
      vbaBytes:wb.vbaraw?.length || 0,
      officeXmlParts:extras.xmlParts,
      vectorTextParts:extras.vectorTextParts,
      mediaInventory:extras.mediaInventory,
      unsupportedMedia:extras.unsupportedMedia,
      embeddedObjects:extras.embeddedObjects,
      archiveEntries:extras.archiveEntries,
    } },
    metrics:{ sheets:sheets.length, rows:totalRows, cells:totalCells, formulas:formulaCount, comments:commentCount, embeddedImages:extras.sidecars.length, embeddedMedia:extras.mediaInventory.length, unsupportedEmbeddedMedia:extras.unsupportedMedia.length, embeddedObjects:extras.embeddedObjects.length },
    limitations: [
      ...(extras.unsupportedMedia.length ? [`${extras.unsupportedMedia.length} mídia(s) Office não raster (ex.: EMF/WMF) permanecem preservadas no arquivo original, mas não receberam OCR local.`] : []),
      ...(extras.embeddedObjects.length ? [`${extras.embeddedObjects.length} objeto(s) OLE/arquivo(s) incorporado(s) permanecem preservados no pacote Office, mas ainda não são extraídos recursivamente.`] : []),
      ...(wb.vbaraw ? ['Projeto VBA detectado e preservado no arquivo original; o código VBA binário não é decompilado nesta versão.'] : []),
    ],
    sidecars:extras.sidecars,
  };
}

function collectXmlTexts(node, out=[]) {
  if (node == null) return out;
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) { node.forEach(x => collectXmlTexts(x,out)); return out; }
  for (const [k,v] of Object.entries(node)) {
    if (k.endsWith(':t') || k === 'a:t' || k === 'w:t') {
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v['#text'] === 'string') out.push(v['#text']);
    } else collectXmlTexts(v,out);
  }
  return out;
}

async function pptxToMachine(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({ ignoreAttributes:false, textNodeName:'#text' });
  const slideNames = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a,b) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]));
  const slides = [];
  const text = [];
  for (const slideName of slideNames) {
    const rawXml = await zip.file(slideName).async('string');
    const parsed = parser.parse(rawXml);
    const texts = collectXmlTexts(parsed);
    const number = Number(slideName.match(/slide(\d+)/i)?.[1] || slides.length + 1);
    slides.push({ number, file:slideName, texts, rawXml, parsed });
    text.push(`### SLIDE ${number}`); text.push(texts.join(' | '));
  }

  const noteNames = Object.keys(zip.files).filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(n));
  const notes = [];
  for (const noteName of noteNames) {
    const rawXml = await zip.file(noteName).async('string');
    const parsed = parser.parse(rawXml);
    const texts = collectXmlTexts(parsed);
    notes.push({ file:noteName, texts, rawXml, parsed });
  }

  const extras = await collectOfficeArchive(buffer, 'ppt');
  return {
    kind:'presentation', extractedBy:'PPTX completo/XML + OCR de mídias', text:clean(text.join('\n')),
    machine:{ presentation:{ slides, notes, officeXmlParts:extras.xmlParts, vectorTextParts:extras.vectorTextParts, mediaInventory:extras.mediaInventory, unsupportedMedia:extras.unsupportedMedia, embeddedObjects:extras.embeddedObjects, archiveEntries:extras.archiveEntries } },
    metrics:{ slides:slides.length, notes:notes.length, embeddedImages:extras.sidecars.length, embeddedMedia:extras.mediaInventory.length, unsupportedEmbeddedMedia:extras.unsupportedMedia.length, embeddedObjects:extras.embeddedObjects.length },
    limitations: [
      ...(extras.unsupportedMedia.length ? [`${extras.unsupportedMedia.length} mídia(s) PowerPoint não raster permanecem preservadas no arquivo original, mas não receberam OCR local.`] : []),
      ...(extras.embeddedObjects.length ? [`${extras.embeddedObjects.length} objeto(s) incorporado(s) do PowerPoint permanecem preservados no pacote, mas ainda não são extraídos recursivamente.`] : []),
    ],
    sidecars:extras.sidecars,
  };
}

async function docxToMachine(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const rawText = clean(result.value || '');
  const extras = await collectOfficeArchive(buffer, 'word');
  let rawDocumentXml = extras.xmlParts['word/document.xml'] || null;
  let parsedDocument = null;
  if (rawDocumentXml) {
    try { parsedDocument = new XMLParser({ ignoreAttributes:false, textNodeName:'#text', trimValues:false }).parse(rawDocumentXml); } catch {}
  }
  return {
    kind:'document', extractedBy:'Mammoth + DOCX pacote XML completo + OCR de mídias', text:rawText,
    machine:{ document:{
      rawText,
      rawDocumentXml,
      parsedDocument,
      officeXmlParts:extras.xmlParts,
      vectorTextParts:extras.vectorTextParts,
      mediaInventory:extras.mediaInventory,
      unsupportedMedia:extras.unsupportedMedia,
      embeddedObjects:extras.embeddedObjects,
      archiveEntries:extras.archiveEntries,
      messages:result.messages || [],
    } },
    metrics:{ characters:rawText.length, lines:rawText ? rawText.split('\n').length : 0, embeddedImages:extras.sidecars.length, embeddedMedia:extras.mediaInventory.length, unsupportedEmbeddedMedia:extras.unsupportedMedia.length, embeddedObjects:extras.embeddedObjects.length },
    limitations: [
      ...(extras.unsupportedMedia.length ? [`${extras.unsupportedMedia.length} mídia(s) Word não raster permanecem preservadas no arquivo original, mas não receberam OCR local.`] : []),
      ...(extras.embeddedObjects.length ? [`${extras.embeddedObjects.length} objeto(s) incorporado(s) do Word permanecem preservados no pacote, mas ainda não são extraídos recursivamente.`] : []),
    ],
    sidecars:extras.sidecars,
  };
}

function normalizeMppProject(project) {
  const extendedDefs = new Map();
  for (const def of asArray(project?.ExtendedAttributes?.ExtendedAttribute)) {
    const id = valueText(def?.FieldID || def?.FieldId);
    const name = valueText(def?.FieldName || def?.Alias || def?.FieldName);
    if (id) extendedDefs.set(id, name || id);
  }

  const tasks = asArray(project?.Tasks?.Task).map(task => {
    const row = compact(pick(task, [
      'UID','ID','Name','Type','WBS','OutlineNumber','OutlineLevel','Priority','Start','Finish','Duration','Work','Cost','FixedCost',
      'Stop','Resume','PercentComplete','PercentWorkComplete','PhysicalPercentComplete','ActualStart','ActualFinish','ActualCost','ActualWork',
      'ActualDuration','RemainingDuration','RemainingWork','RemainingCost','ConstraintType','ConstraintDate','Deadline','Critical','Milestone','Summary',
      'Active','TotalSlack','FreeSlack','CalendarUID','Notes','CreateDate','Manual','IsNull','Rollup','OverAllocated','ExternalTask','ExternalProject'
    ]));
    const baselines = asArray(task?.Baseline).map(b => compact(b));
    if (baselines.length) row.Baselines = baselines;
    const predecessors = asArray(task?.PredecessorLink).map(link => compact(link));
    if (predecessors.length) row.Predecessors = predecessors;
    const custom = asArray(task?.ExtendedAttribute).map(ext => {
      const fieldId = valueText(ext?.FieldID || ext?.FieldId);
      const rawValue = valueText(ext?.Value || ext?.Description || ext?.DurationValue || ext?.DateValue || ext?.NumericValue);
      return fieldId && rawValue ? { ...compact(ext), fieldId, fieldName:extendedDefs.get(fieldId) || fieldId, value:rawValue } : compact(ext);
    }).filter(x => Object.keys(x).length);
    if (custom.length) row.CustomFields = custom;
    return row;
  });

  return {
    projectInfo: compact(pick(project, [
      'Name','Title','Subject','Category','Company','Manager','Author','CreationDate','LastSaved','ScheduleFromStart',
      'StartDate','FinishDate','FYStartDate','CriticalSlackLimit','CurrentDate','StatusDate','CalendarUID','DefaultStartTime',
      'DefaultFinishTime','MinutesPerDay','MinutesPerWeek','DaysPerMonth','CurrencySymbol','CurrencyCode','ProjectExternallyEdited',
      'ActualsInSync','RemoveFileProperties','AdminProject','Autolink','NewTasksEffortDriven','NewTasksEstimated','SplitsInProgressTasks'
    ])),
    tasks,
    resources: asArray(project?.Resources?.Resource),
    assignments: asArray(project?.Assignments?.Assignment),
    calendars: asArray(project?.Calendars?.Calendar),
    extendedAttributeDefinitions: asArray(project?.ExtendedAttributes?.ExtendedAttribute),
    outlineCodes:asArray(project?.OutlineCodes?.OutlineCode),
    wbsMasks:project?.WBSMasks || null,
  };
}

function mppText(normalized) {
  const out = ['### MICROSOFT PROJECT / MPP','### PROJETO'];
  Object.entries(normalized.projectInfo || {}).forEach(([k,v]) => out.push(`${k}: ${valueText(v)}`));
  out.push(`### TAREFAS (${normalized.tasks.length})`);
  for (const task of normalized.tasks) out.push(JSON.stringify(task));
  out.push(`### RECURSOS (${normalized.resources.length})`);
  for (const resource of normalized.resources) out.push(JSON.stringify(resource));
  out.push(`### ATRIBUIÇÕES (${normalized.assignments.length})`);
  for (const assignment of normalized.assignments) out.push(JSON.stringify(assignment));
  out.push(`### CALENDÁRIOS (${normalized.calendars.length})`);
  for (const calendar of normalized.calendars) out.push(JSON.stringify(calendar));
  return out.join('\n');
}

async function mppToMachine(buffer, originalName) {
  let convert;
  try { ({ convert } = await import('@byteink/mppjs')); }
  catch (error) { throw new Error(`Leitor MPP nativo não instalado. Execute INSTALL.bat novamente. Detalhe: ${error.message}`); }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-mpp-'));
  const safeName = originalName.replace(/[\\/:*?"<>|]/g,'_');
  const input = path.join(dir, safeName.toLowerCase().endsWith('.mpp') ? safeName : `${safeName}.mpp`);
  const output = path.join(dir, `${path.parse(safeName).name || 'project'}.xml`);
  await fs.writeFile(input, buffer);
  try {
    await convert(input, output);
    const rawXml = await fs.readFile(output, 'utf8');
    if (!rawXml.trim()) throw new Error('O conversor MPP não gerou conteúdo XML.');
    const parser = new XMLParser({ ignoreAttributes:false, removeNSPrefix:true, parseTagValue:false, parseAttributeValue:false, trimValues:true });
    const parsed = parser.parse(rawXml);
    const project = parsed?.Project || parsed?.project;
    if (!project) throw new Error('O XML convertido não contém a estrutura Project.');
    const normalized = normalizeMppProject(project);
    return {
      kind:'project', extractedBy:'MPP nativo / MPXJ + MSPDI completo', text:mppText(normalized),
      machine:{ project:{ ...normalized, rawProject:project, rawMspdiXml:rawXml } },
      metrics:{ tasks:normalized.tasks.length, resources:normalized.resources.length, assignments:normalized.assignments.length, calendars:normalized.calendars.length },
    };
  } finally {
    await fs.rm(dir, { recursive:true, force:true }).catch(()=>{});
  }
}

async function pdfNativePages(buffer) {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({ data:new Uint8Array(buffer), disableWorker:true, useSystemFonts:true });
    const document = await loadingTask.promise;
    const pages = [];
    for (let n=1; n<=document.numPages; n++) {
      const page = await document.getPage(n);
      const content = await page.getTextContent();
      const items = (content.items || []).map(item => ({
        str:item.str || '', dir:item.dir || null, width:item.width ?? null, height:item.height ?? null,
        transform:item.transform || null, fontName:item.fontName || null,
      }));
      pages.push({ page:n, text:clean(items.map(x => x.str).join(' ')), items });
    }
    await document.destroy?.();
    return pages;
  } catch { return []; }
}

async function pdfToMachine(buffer) {
  const result = await pdf(buffer);
  const nativeText = clean(result.text || '');
  const nativePages = await pdfNativePages(buffer);
  const pageText = nativePages.length ? nativePages.map(p => `### PÁGINA ${p.page}\n${p.text}`).join('\n\n') : nativeText;
  return {
    kind:'pdf', extractedBy:'PDF texto nativo por página + metadados + OCR integral', text:clean(pageText || nativeText),
    machine:{ pdf:{
      pages:result.numpages || nativePages.length || null,
      info:result.info || {}, metadata:result.metadata || null,
      nativeText, nativePages,
    } },
    metrics:{ pages:result.numpages || nativePages.length || null, characters:(pageText || nativeText).length, nativePageSegments:nativePages.length },
    requiresVision:true,
    preserveBlob:true,
  };
}

function xmlToMachine(buffer) {
  const rawXml = clean(buffer.toString('utf8'));
  let parsed = null;
  try { parsed = new XMLParser({ ignoreAttributes:false, trimValues:false }).parse(rawXml); } catch {}
  return { kind:'xml', extractedBy:'XML integral + fast-xml-parser', text:rawXml, machine:{ xml:{ parsed, rawXml } }, metrics:{ characters:rawXml.length } };
}

export async function extractFileNative(file, buffer) {
  const ext = (file.ext || path.extname(file.name)).toLowerCase();
  if (buffer.length > config.maxFileBytes) throw new Error(`Arquivo excede o limite de ${Math.round(config.maxFileBytes/1024/1024)} MB.`);

  let extracted;
  if (imageExts.has(ext)) {
    extracted = {
      kind:'image', extractedBy:'Imagem original', text:'',
      machine:{ image:{ fileName:file.name, extension:ext, bytes:buffer.length } },
      metrics:{ bytes:buffer.length }, requiresVision:true, preserveBlob:true,
    };
  } else if (ext === '.mpp') extracted = await mppToMachine(buffer, file.name);
  else if (['.xlsx','.xlsm','.xls','.xlsb'].includes(ext)) extracted = await excelToMachine(buffer);
  else if (ext === '.docx') extracted = await docxToMachine(buffer);
  else if (ext === '.pptx') extracted = await pptxToMachine(buffer);
  else if (ext === '.pdf') extracted = await pdfToMachine(buffer);
  else if (ext === '.xml') extracted = xmlToMachine(buffer);
  else if (textExts.has(ext)) {
    const raw = buffer.toString('utf8');
    const text = clean(raw);
    let parsedJson = null;
    if (ext === '.json') { try { parsedJson = JSON.parse(text); } catch {} }
    extracted = { kind:'text', extractedBy:'Texto integral', text, machine:{ text:{ raw, normalized:text, parsedJson } }, metrics:{ characters:text.length, lines:text ? text.split('\n').length : 0 } };
  } else {
    const sample = buffer.subarray(0, Math.min(buffer.length, 12000));
    const zeroRatio = sample.length ? [...sample].filter(x => x === 0).length / sample.length : 0;
    if (zeroRatio < 0.01) {
      const raw = buffer.toString('utf8');
      const text = clean(raw);
      extracted = { kind:'text', extractedBy:'Texto genérico integral', text, machine:{ text:{ raw, normalized:text } }, metrics:{ characters:text.length } };
    } else {
      extracted = {
        kind:'binary', extractedBy:'Binário preservado integralmente', text:'',
        machine:{ binary:{ fileName:file.name, extension:ext || null, bytes:buffer.length, note:'Sem extrator específico; fonte original preservada integralmente no snapshot.' } },
        metrics:{ bytes:buffer.length }, preserveBlob:true, requiresVision:false,
      };
    }
  }
  return extracted;
}

export function extractionNeedsOcr(extracted) {
  if (!config.ocr.enabled) return false;
  if (!extracted) return false;
  if (extracted.kind === 'image' || extracted.kind === 'pdf') return true;
  return Array.isArray(extracted.sidecars) && extracted.sidecars.length > 0;
}

function finishArtifact(file, extracted) {
  extracted.analysisCorpus = buildAnalysisCorpus(extracted);
  extracted.coverage = extracted.analysisCorpus.coverage;
  extracted.technicalSummary = buildTechnicalSummary(extracted);
  return {
    schemaVersion:4,
    ...extracted,
    machineReadable:true,
    source:{ name:file.name, relativePath:file.relativePath, modifiedTime:file.modifiedTime, size:file.size, mimeType:file.mimeType || null },
  };
}

export function finalizeNativeArtifact(file, extracted, { ocrPending=false, ocrNote='' } = {}) {
  extracted.nativeText = clean(extracted.text || '');
  extracted.ocrText = '';
  extracted.text = extracted.nativeText;
  extracted.ocr = {
    enabled:Boolean(config.ocr.enabled),
    eligible:Boolean(ocrPending),
    notApplicable:!ocrPending,
    applied:false,
    complete:!ocrPending,
    pending:Boolean(ocrPending),
    targetCount:ocrPending ? null : 0,
    completedTargets:0,
    failedTargets:0,
    characters:0,
    note:ocrNote || (ocrPending ? 'Extração nativa concluída; OCR ainda pendente.' : 'OCR não aplicável: nenhum conteúdo visual elegível foi detectado; a extração nativa/estruturada é a fonte principal.'),
  };
  if (ocrPending) {
    extracted.limitations = [
      ...(extracted.limitations || []),
      'OCR ainda não concluído neste checkpoint. A extração nativa já está preservada.',
    ];
  }
  return finishArtifact(file, extracted);
}

export async function finalizeArtifactWithOcr(file, buffer, extracted) {
  extracted = await enrichExtractionWithOcr({ file, buffer, extracted });
  return finishArtifact(file, extracted);
}

export async function extractFile(file, buffer) {
  const native = await extractFileNative(file, buffer);
  return finalizeArtifactWithOcr(file, buffer, native);
}
