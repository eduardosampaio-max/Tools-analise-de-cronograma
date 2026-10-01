import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { walkFiles, normalizePathForDisplay } from '../utils/fs.js';
import { normalizeProjectBase, relativeCronogramaSegments, relativeCronogramaPath } from '../domain/projectBase.js';

const AREAS = Object.keys(config.localRoots);

async function inspectRoot(area) {
  const root = config.localRoots[area];
  if (!root) return { area, root, accessible: false, error: 'Diretório-base não configurado.' };
  try {
    await fs.access(root);
    const entries = await fs.readdir(root, { withFileTypes: true });
    return { area, root, accessible: true, entries, error: null };
  } catch (error) {
    return {
      area,
      root,
      accessible: false,
      entries: [],
      error: `${error.code || 'ERRO'}: ${error.message}`,
    };
  }
}

async function listObras() {
  const obras = [];
  const warnings = [];

  for (const area of AREAS) {
    const check = await inspectRoot(area);
    if (!check.accessible) {
      warnings.push(`${area}: não foi possível acessar ${check.root} (${check.error})`);
      continue;
    }

    for (const entry of check.entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        obras.push({ area, name: entry.name, source: 'local' });
      }
    }
  }

  return {
    obras: obras.sort((a,b) => a.name.localeCompare(b.name, 'pt-BR')),
    warnings,
  };
}

async function getDiagnostics() {
  const roots = {};
  for (const area of AREAS) {
    const check = await inspectRoot(area);
    roots[area] = {
      path: check.root,
      accessible: check.accessible,
      error: check.error,
      directoryCount: check.accessible ? check.entries.filter(e => e.isDirectory()).length : 0,
    };
  }
  return roots;
}

async function resolveObra(area, obra) {
  const root = config.localRoots[area];
  if (!root) throw new Error(`Área inválida: ${area}`);

  const check = await inspectRoot(area);
  if (!check.accessible) {
    throw new Error(`Diretório-base não acessível: ${root}. ${check.error || ''}`.trim());
  }

  const hit = check.entries.find(e => e.isDirectory() && e.name.toLowerCase() === obra.toLowerCase());
  if (!hit) throw new Error(`Obra “${obra}” não encontrada em ${area}.`);
  return path.join(root, hit.name);
}

async function locateCronograma(area, obra, projectBase='GO') {
  const base=normalizeProjectBase(projectBase);
  // O caminho é determinístico e depende da base escolhida pelo usuário.
  // GO: <RAIZ>/<OBRA>/GO/CRONOGRAMA
  // GP Residencial/Corporativo: <RAIZ>/<OBRA>/GP/COORD/CRONOGRAMA
  // GP Predial: <RAIZ>/<OBRA>/COORD/CRONOGRAMA
  // Não fazemos busca recursiva fora da pasta CRONOGRAMA.
  const obraRoot = await resolveObra(area, obra);
  const segments = relativeCronogramaSegments(area, base);
  const cronogramaPath = path.join(obraRoot, ...segments);

  try {
    const stat = await fs.stat(cronogramaPath);
    if (!stat.isDirectory()) throw new Error('O caminho existe, mas não é uma pasta.');
  } catch (error) {
    throw new Error(
      `Pasta padrão da base ${base} não encontrada para a obra “${obra}”. Esperado: ${cronogramaPath}. ` +
      `O sistema não pesquisa outras pastas da obra. ${error.code ? `[${error.code}] ` : ''}${error.message}`
    );
  }

  return {
    id: cronogramaPath,
    name: 'CRONOGRAMA',
    path: normalizePathForDisplay(cronogramaPath),
    fsPath: cronogramaPath,
    obraRoot: normalizePathForDisplay(obraRoot),
    source: 'local',
    projectBase: base,
    relativeBasePath: relativeCronogramaPath(area,base,'\\'),
    pathMode: 'fixed',
  };
}

async function statDescriptor(full, basePath) {
  const stat = await fs.stat(full, { bigint:true });
  const stableId = stat.ino && stat.ino !== 0n ? `local:${stat.dev.toString()}:${stat.ino.toString()}` : null;
  const rel = path.relative(basePath, full);
  return {
    id: full,
    rootId: basePath,
    name: path.basename(full),
    ext: path.extname(full).toLowerCase(),
    path: normalizePathForDisplay(full),
    relativePath: normalizePathForDisplay(rel),
    size: Number(stat.size),
    modifiedTime: new Date(Number(stat.mtimeMs)).toISOString(),
    mimeType: '',
    source: 'local',
    stableId,
  };
}

async function listCronogramaFiles(folder) {
  const basePath = folder.fsPath || folder.path;
  const files = await walkFiles(basePath);
  return Promise.all(files.map(async full => {
    try {
      return await statDescriptor(full, basePath);
    } catch (error) {
      const rel = path.relative(basePath, full);
      // O arquivo continua entrando no snapshot mesmo se metadata/stat falhar.
      // A etapa de leitura tentará reencontrá-lo antes de gerar diagnóstico.
      return {
        id: full,
        rootId: basePath,
        name: path.basename(full),
        ext: path.extname(full).toLowerCase(),
        path: normalizePathForDisplay(full),
        relativePath: normalizePathForDisplay(rel),
        size: 0,
        modifiedTime: null,
        mimeType: '',
        source: 'local',
        stableId:null,
        discoveryError:`${error.code || 'ERRO'}: ${error.message}`,
      };
    }
  }));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function norm(v='') { return normalizePathForDisplay(String(v)).toLowerCase(); }
function closeModifiedTime(a,b) {
  if (!a || !b) return false;
  const aa = new Date(a).getTime();
  const bb = new Date(b).getTime();
  return Number.isFinite(aa) && Number.isFinite(bb) && Math.abs(aa-bb) <= 2500;
}

async function recoverFileReference(file) {
  const root = file.rootId;
  if (!root) return null;

  // 1) Reconstrói diretamente o caminho a partir do root + relativePath.
  if (file.relativePath) {
    const rebuilt = path.join(root, ...String(file.relativePath).replaceAll('\\','/').split('/').filter(Boolean));
    try { return await statDescriptor(rebuilt, root); } catch {}
  }

  // 2) Revarre somente a pasta CRONOGRAMA da base selecionada quando o caminho inventariado sumiu.
  // Isso cobre rename/move realizado pelo usuário ou pelo Google Drive durante a sincronização.
  let current = [];
  try { current = await walkFiles(root); } catch { return null; }
  if (!current.length) return null;

  const descriptors = [];
  for (const full of current) {
    try { descriptors.push(await statDescriptor(full, root)); } catch {}
  }

  if (file.stableId) {
    const sameIdentity = descriptors.find(x => x.stableId && x.stableId === file.stableId);
    if (sameIdentity) return sameIdentity;
  }

  const exactRel = descriptors.find(x => norm(x.relativePath) === norm(file.relativePath));
  if (exactRel) return exactRel;

  const sameMetadata = descriptors.filter(x =>
    String(x.ext || '').toLowerCase() === String(file.ext || '').toLowerCase() &&
    Number(x.size || 0) === Number(file.size || 0) &&
    closeModifiedTime(x.modifiedTime, file.modifiedTime)
  );
  if (sameMetadata.length === 1) return sameMetadata[0];

  const sameName = descriptors.filter(x => String(x.name || '').toLowerCase() === String(file.name || '').toLowerCase());
  if (sameName.length === 1) return sameName[0];
  return null;
}

function applyRecoveredReference(file, recovered) {
  if (!recovered) return;
  const previous = { id:file.id, path:file.path, relativePath:file.relativePath, name:file.name };
  Object.assign(file, recovered, {
    recoveredSource:true,
    recoveredFrom:previous,
  });
}

async function readNative(full, signal) {
  return fs.readFile(full, signal ? { signal } : undefined);
}

async function readFile(file, options={}) {
  const signal = options?.signal;
  const retryable = new Set(['ENOENT','EBUSY','EPERM','EACCES','EIO']);
  const waits = [0, 500, 1500, 3000];
  let lastError = null;

  for (let attempt=0; attempt<waits.length; attempt++) {
    if (signal?.aborted) {
      const error = new Error(`Leitura de “${file.name}” cancelada.`);
      error.code = 'ABORT_ERR';
      throw error;
    }
    if (waits[attempt]) await sleep(waits[attempt]);
    try {
      return await readNative(file.id, signal);
    } catch (error) {
      lastError = error;
      if (!retryable.has(error?.code)) throw error;

      // ENOENT depois do inventário normalmente significa rename/move/sincronização do Drive.
      // Em vez de gravar uma limitação falsa, tentamos reencontrar o MESMO arquivo em CRONOGRAMA.
      if (error?.code === 'ENOENT') {
        const recovered = await recoverFileReference(file);
        if (recovered) {
          applyRecoveredReference(file, recovered);
          try { return await readNative(file.id, signal); }
          catch (retryError) { lastError = retryError; }
        }
      }
    }
  }

  if (lastError?.code === 'ENOENT') {
    const error = new Error(
      `Arquivo inventariado não estava mais disponível no caminho no momento da leitura e não pôde ser reencontrado após novas tentativas: ${file.path || file.id}`
    );
    error.code = 'SOURCE_NOT_FOUND_AFTER_RETRY';
    error.cause = lastError;
    throw error;
  }
  throw lastError;
}

export const localProvider = { listObras, getDiagnostics, locateCronograma, listCronogramaFiles, readFile };
