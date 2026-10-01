const STOPWORDS = new Set(`a o as os um uma uns umas de da do das dos em no na nos nas para por com sem sob sobre entre e ou mas que se ao aos à às é são foi foram ser sendo ter tem têm como mais menos muito muita muitos muitas este esta estes estas esse essa isso aquele aquela sua seu seus suas meu minha nosso nossa pelo pela pelos pelas já ainda também então onde quando qual quais cada todo toda todos todas arquivo arquivos documento documentos cronograma obra projeto projetos página paginas pagina folha folhas texto dados informação informacoes informações tabela tabelas campo campos`.split(/\s+/));

function textOf(value) { return value == null ? '' : String(value); }
function yes(value) { return ['1','true','yes','sim'].includes(textOf(value).toLowerCase()); }
function asArray(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function compactText(text='') { return textOf(text).replace(/\s+/g,' ').trim(); }
function clip(text, max=650) { const t=compactText(text); return t.length > max ? `${t.slice(0,max).trim()}…` : t; }

function topKeywords(text, max=12) {
  const tokens = textOf(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .match(/[a-z0-9_%-]{4,}/g) || [];
  const counts = new Map();
  for (const token of tokens) {
    if (STOPWORDS.has(token) || /^\d+$/.test(token) || token.length > 35) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,max).map(([term,count])=>({term,count}));
}

function dates(text, max=12) {
  const found = textOf(text).match(/\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-](?:\d{2}|\d{4})|\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?)\b/g) || [];
  return [...new Set(found)].slice(0,max);
}

function headings(text, max=10) {
  const out = [];
  for (const raw of textOf(text).split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (!line || line.length < 4 || line.length > 130 || line.includes('{') || line.includes('}')) continue;
    const words = line.split(/\s+/);
    if (words.length > 18) continue;
    const letters = line.replace(/[^A-Za-zÀ-ÿ]/g,'');
    const upperRatio = letters ? (letters.replace(/[^A-ZÀ-Ý]/g,'').length / letters.length) : 0;
    if (raw.trim().startsWith('#') || /:$/.test(line) || upperRatio > .72) out.push(line.replace(/:$/,''));
    if (out.length >= max) break;
  }
  return [...new Set(out)];
}

function mppSummary(extracted) {
  const p = extracted.machine?.project || {};
  const info = p.projectInfo || {};
  const tasks = asArray(p.tasks);
  const critical = tasks.filter(t => yes(t.Critical)).length;
  const milestones = tasks.filter(t => yes(t.Milestone)).length;
  const summaries = tasks.filter(t => yes(t.Summary)).length;
  const names = tasks.map(t => compactText(t.Name)).filter(Boolean).slice(0,8);
  const bullets = [
    `${tasks.length} tarefas (${summaries} tarefas-resumo, ${milestones} marcos e ${critical} críticas).`,
    `${asArray(p.resources).length} recursos, ${asArray(p.assignments).length} atribuições e ${asArray(p.calendars).length} calendários.`,
  ];
  if (info.StartDate || info.FinishDate) bullets.push(`Janela do projeto: ${info.StartDate || '—'} até ${info.FinishDate || '—'}.`);
  if (info.StatusDate) bullets.push(`Data de status registrada no Project: ${info.StatusDate}.`);
  if (names.length) bullets.push(`Primeiras atividades identificadas: ${names.join(' · ')}.`);
  return { title:'Cronograma Microsoft Project estruturado', bullets };
}

function spreadsheetSummary(extracted) {
  const wb = extracted.machine?.workbook || {};
  const sheets = asArray(wb.sheets);
  const names = sheets.map(s => s.name).filter(Boolean);
  const bullets = [
    `${sheets.length} aba(s): ${names.slice(0,12).join(', ') || 'nomes não identificados'}.`,
    `${extracted.metrics?.rows || 0} linhas, ${extracted.metrics?.cells || 0} células e ${extracted.metrics?.formulas || 0} fórmulas extraídas.`,
  ];
  if (extracted.metrics?.embeddedImages) bullets.push(`${extracted.metrics.embeddedImages} imagem(ns) embutida(s); OCR executado nas imagens elegíveis.`);
  return { title:'Planilha estruturada por abas, células e fórmulas', bullets };
}

function pdfSummary(extracted) {
  const nativeChars = extracted.machine?.pdf?.nativeText?.length ?? extracted.machine?.pdf?.text?.length ?? 0;
  const ocrPages = extracted.metrics?.ocrPages || 0;
  const bullets = [
    `${extracted.metrics?.pages || '?'} página(s) detectada(s).`,
    `${nativeChars} caracteres obtidos da camada textual nativa.`,
  ];
  if (extracted.ocr?.pdf?.skipped) bullets.push(`OCR do PDF não foi executado: ${extracted.ocr.pdf.reason || 'configuração/condição de leitura'}.`);
  else bullets.push(`${ocrPages} página(s) processada(s) por OCR, com ${extracted.metrics?.ocrCharacters || 0} caracteres adicionais.`);
  return { title:'Documento PDF com camada nativa + OCR complementar integral', bullets };
}

function presentationSummary(extracted) {
  const slides = asArray(extracted.machine?.presentation?.slides);
  const slideTitles = slides.map(s => asArray(s.texts).find(t => compactText(t).length > 2 && compactText(t).length < 120)).filter(Boolean).slice(0,8);
  const bullets = [
    `${extracted.metrics?.slides || slides.length} slide(s) e ${extracted.metrics?.notes || 0} bloco(s) de notas.`,
    `${extracted.metrics?.embeddedImages || 0} imagem(ns) embutida(s), com OCR aplicado às elegíveis.`,
  ];
  if (slideTitles.length) bullets.push(`Textos/títulos iniciais: ${slideTitles.join(' · ')}.`);
  return { title:'Apresentação PowerPoint decomposta por slides, notas e mídias', bullets };
}

function documentSummary(extracted) {
  return { title:'Documento Word convertido para texto e estrutura XML', bullets:[
    `${extracted.metrics?.characters || 0} caracteres em ${extracted.metrics?.lines || 0} linha(s).`,
    `${extracted.metrics?.embeddedImages || 0} imagem(ns) embutida(s), com OCR aplicado às elegíveis.`,
  ]};
}

function genericSummary(extracted) {
  const kind = extracted.kind || 'arquivo';
  return { title:`Conteúdo técnico extraído do tipo ${kind}`, bullets:[
    `${extracted.metrics?.characters ?? extracted.text?.length ?? 0} caracteres disponíveis para busca/análise.`,
    extracted.metrics?.ocrCharacters ? `${extracted.metrics.ocrCharacters} caracteres foram recuperados por OCR.` : 'Nenhum texto adicional de OCR foi necessário ou encontrado.',
  ]};
}

export function buildTechnicalSummary(extracted) {
  let base;
  if (extracted.kind === 'project') base = mppSummary(extracted);
  else if (extracted.kind === 'spreadsheet') base = spreadsheetSummary(extracted);
  else if (extracted.kind === 'pdf') base = pdfSummary(extracted);
  else if (extracted.kind === 'presentation') base = presentationSummary(extracted);
  else if (extracted.kind === 'document') base = documentSummary(extracted);
  else if (extracted.kind === 'image') base = {
    title:'Imagem processada por OCR local',
    bullets:[
      `${extracted.metrics?.ocrCharacters || 0} caracteres reconhecidos.`,
      extracted.ocr?.images?.[0]?.confidence != null ? `Confiança média OCR: ${extracted.ocr.images[0].confidence}%.` : 'Confiança OCR não disponível.',
    ],
  };
  else base = genericSummary(extracted);

  const text = textOf(extracted.text || '');
  const kws = topKeywords(text);
  const dts = dates(text);
  const hds = headings(text);
  const preview = clip(text, 900);
  const ocrApplied = Boolean(extracted.ocr?.applied);
  const ocrErrors = [
    ...(extracted.ocr?.images || []).map(x => x.error).filter(Boolean),
    extracted.ocr?.pdf?.error,
  ].filter(Boolean);

  const coverage = extracted.coverage || extracted.analysisCorpus?.coverage || null;
  const coverageBullet = coverage?.status === 'partial' && coverage.limitations?.length
    ? `Cobertura parcial declarada: ${coverage.limitations.join(' | ')}`
    : 'Cobertura completa para os extratores disponíveis nesta versão.';
  const narrative = [base.title, ...base.bullets, coverageBullet].join(' ');
  return {
    generatedBy:'Regras determinísticas + OCR local (sem LLM)',
    usesAI:false,
    title:base.title,
    narrative,
    bullets:[...base.bullets, coverageBullet],
    headings:hds,
    keywords:kws,
    dates:dts,
    textPreview:preview,
    textCharacters:text.length,
    coverage,
    corpusStats:extracted.analysisCorpus?.stats || null,
    ocr:{
      enabled:Boolean(extracted.ocr?.enabled),
      eligible:extracted.ocr?.eligible !== false,
      notApplicable:Boolean(extracted.ocr?.notApplicable),
      complete:extracted.ocr?.complete !== false,
      applied:ocrApplied,
      characters:extracted.metrics?.ocrCharacters || 0,
      images:extracted.metrics?.ocrImages || 0,
      pages:extracted.metrics?.ocrPages || 0,
      failedImages:extracted.metrics?.ocrFailedImages || 0,
      failedPages:extracted.metrics?.ocrFailedPages || 0,
      failedTargets:extracted.ocr?.failedTargets ?? null,
      errors:ocrErrors,
    },
  };
}
