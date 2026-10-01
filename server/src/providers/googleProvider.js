import path from 'node:path';
import { google } from 'googleapis';
import { config } from '../config.js';
import { normalizeProjectBase, relativeCronogramaSegments, relativeCronogramaPath } from '../domain/projectBase.js';

const FOLDER = 'application/vnd.google-apps.folder';
const googleExports = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
};

let driveClient;
function getDrive() {
  if (driveClient) return driveClient;
  if (!config.google.serviceAccountJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado.');
  let credentials;
  try { credentials = JSON.parse(config.google.serviceAccountJson); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON deve conter o JSON completo da service account.'); }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

const esc = s => s.replaceAll("'", "\\'");

async function listChildren(parentId) {
  const drive = getDrive();
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function findRoot(area) {
  if (config.google.roots[area]) return { id: config.google.roots[area], name: config.google.rootNames[area] };
  const drive = getDrive();
  const name = config.google.rootNames[area];
  const res = await drive.files.list({
    q: `name='${esc(name)}' and mimeType='${FOLDER}' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 20,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (!res.data.files?.length) throw new Error(`Pasta raiz ${name} não encontrada no Google Drive.`);
  return res.data.files[0];
}

async function listObras() {
  const obras = [];
  for (const area of ['RESIDENCIAL','CORPORATIVO','PREDIAL']) {
    try {
      const root = await findRoot(area);
      const children = await listChildren(root.id);
      for (const item of children) if (item.mimeType === FOLDER) obras.push({ area, name: item.name, id: item.id, source: 'google' });
    } catch (error) {
      console.warn(`[drive:${area}] ${error.message}`);
    }
  }
  return obras.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
}

async function resolveObra(area, obra) {
  const root = await findRoot(area);
  const children = await listChildren(root.id);
  const hit = children.find(x => x.mimeType === FOLDER && x.name.toLowerCase() === obra.toLowerCase());
  if (!hit) throw new Error(`Obra “${obra}” não encontrada em ${area}.`);
  return { ...hit, path: `${root.name}/${hit.name}` };
}

async function locateCronograma(area, obra, projectBase='GO') {
  const base=normalizeProjectBase(projectBase);
  // Caminho determinístico por base. Não percorremos outras pastas da obra.
  const obraFolder = await resolveObra(area, obra);
  const segments=relativeCronogramaSegments(area,base);
  let current={...obraFolder};
  let currentPath=obraFolder.path;
  for(const segment of segments){
    const children=await listChildren(current.id);
    const hit=children.find(item=>item.mimeType===FOLDER && item.name.toLowerCase()===segment.toLowerCase());
    if(!hit){
      const expected=`${obraFolder.path}/${relativeCronogramaPath(area,base,'/')}`;
      throw new Error(`Pasta padrão da base ${base} não encontrada: ${expected}. O sistema não pesquisa outras pastas da obra.`);
    }
    current=hit;
    currentPath=`${currentPath}/${hit.name}`;
  }

  return {
    ...current,
    path:currentPath,
    source:'google',
    projectBase:base,
    relativeBasePath:relativeCronogramaPath(area,base,'/'),
    pathMode:'fixed',
  };
}

async function listCronogramaFiles(folder) {
  const out = [];
  async function walk(parentId, rel, depth) {
    if (depth > 50) return;
    const children = await listChildren(parentId);
    for (const child of children) {
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      if (child.mimeType === FOLDER) await walk(child.id, childRel, depth+1);
      else {
        const exportInfo = googleExports[child.mimeType];
        const ext = exportInfo?.ext || path.extname(child.name).toLowerCase();
        out.push({
          id: child.id, name: child.name, ext, path: `${folder.path}/${childRel}`,
          relativePath: childRel, size: Number(child.size || 0), modifiedTime: child.modifiedTime,
          mimeType: child.mimeType, source: 'google', stableId:`google:${child.id}`, exportInfo,
        });
      }
    }
  }
  await walk(folder.id, '', 0);
  return out;
}

async function readFile(file) {
  const drive = getDrive();
  let res;
  if (file.exportInfo) {
    res = await drive.files.export({ fileId: file.id, mimeType: file.exportInfo.mime }, { responseType: 'arraybuffer' });
  } else {
    res = await drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  }
  return Buffer.from(res.data);
}

export const googleProvider = { listObras, locateCronograma, listCronogramaFiles, readFile };
