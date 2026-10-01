import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const dir = path.join(config.dataDir,'ai-results');
function safeId(id='') { return String(id).replace(/[^a-zA-Z0-9._-]/g,'_'); }
export async function savePreparedAiResult(id,payload) {
  await fsp.mkdir(dir,{recursive:true});
  const file=path.join(dir,`${safeId(id)}.json`);
  await fsp.writeFile(file,JSON.stringify(payload,null,2),'utf8');
  return file;
}
export function preparedAiResultPath(id) { return path.join(dir,`${safeId(id)}.json`); }
export async function loadPreparedAiResult(id) {
  const file=preparedAiResultPath(id);
  if (!fs.existsSync(file)) throw new Error('Resultado preparado não encontrado.');
  return JSON.parse(await fsp.readFile(file,'utf8'));
}
export function analysisContextPath(id){ return path.join(dir,`${safeId(id)}.context.json`); }
export async function saveAnalysisContext(id,canonicalContext){ await fsp.mkdir(dir,{recursive:true}); const file=analysisContextPath(id); await fsp.writeFile(file,JSON.stringify(canonicalContext,null,2),'utf8'); return file; }
export async function loadAnalysisContext(id){ const file=analysisContextPath(id); if(!fs.existsSync(file)) throw new Error('Contexto desta análise não encontrado.'); return JSON.parse(await fsp.readFile(file,'utf8')); }
