const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const LOCAL_HOST = typeof window !== 'undefined' && ['localhost','127.0.0.1'].includes(window.location.hostname);
const DOWNLOAD_API = (import.meta.env.VITE_DOWNLOAD_API_URL || (LOCAL_HOST ? 'http://localhost:3001' : API)).replace(/\/$/, '');

function connectionError() {
  const destination = API || 'http://localhost:3001 (via proxy do Vite)';
  return new Error(`Backend/API não acessível em ${destination}. Abra http://localhost:3001/api/health para diagnóstico.`);
}

async function jsonFetch(url, options = {}) {
  let response;
  try {
    response = await fetch(`${API}${url}`, {
      ...options,
      headers: { 'Content-Type':'application/json', ...(options.headers || {}) },
    });
  } catch { throw connectionError(); }
  const contentType = response.headers.get('content-type') || '';
  let body = {};
  if (contentType.includes('application/json')) body = await response.json().catch(() => ({}));
  else body = { raw:await response.text().catch(() => '') };
  if (!response.ok) {
    const error=new Error(body.error || `Erro HTTP ${response.status}${body.raw ? `: ${body.raw.slice(0,250)}` : ''}`);
    error.details=body.details || null; error.body=body; error.httpStatus=response.status; throw error;
  }
  return body;
}

export const api = {
  health: () => jsonFetch('/api/health'),
  testAiProvider: () => jsonFetch('/api/ai-provider-test', { method:'POST', body:'{}' }),
  obras: () => jsonFetch('/api/obras'),
  latestSync: (area, obra, base='GO') => jsonFetch(`/api/syncs/latest?area=${encodeURIComponent(area)}&obra=${encodeURIComponent(obra)}&base=${encodeURIComponent(base)}`),
  projectBaseStatus: (area,obra) => jsonFetch(`/api/project-bases/status?area=${encodeURIComponent(area)}&obra=${encodeURIComponent(obra)}`),
  getSyncSchedule: (area,obra,base='GO') => jsonFetch(`/api/sync-schedules?area=${encodeURIComponent(area)}&obra=${encodeURIComponent(obra)}&base=${encodeURIComponent(base)}`),
  saveSyncSchedule: payload => jsonFetch('/api/sync-schedules',{method:'PUT',body:JSON.stringify(payload)}),
  runScheduledSyncNow: payload => jsonFetch('/api/sync-schedules/run-now',{method:'POST',body:JSON.stringify(payload)}),

  createExtraction: payload => jsonFetch('/api/extractions', { method:'POST', body:JSON.stringify(payload) }),
  getExtraction: id => jsonFetch(`/api/extractions/${id}`),
  extractionEventsUrl: id => `${API}/api/extractions/${id}/events`,
  getSnapshot: id => jsonFetch(`/api/snapshots/${id}`),
  getArtifactPreview: (snapshotId,index) => jsonFetch(`/api/snapshots/${snapshotId}/files/${index}`),
  artifactExportUrl: (snapshotId,index,format='json') => `${DOWNLOAD_API}/api/snapshots/${snapshotId}/files/${index}/export?format=${encodeURIComponent(format)}`,
  artifactSourceUrl: (snapshotId,index) => `${DOWNLOAD_API}/api/snapshots/${snapshotId}/files/${index}/source`,
  projectJsonUrl: snapshotId => `${DOWNLOAD_API}/api/snapshots/${snapshotId}/corpus?format=json`,
  projectTextUrl: snapshotId => `${DOWNLOAD_API}/api/snapshots/${snapshotId}/corpus?format=txt`,
  jsonPackageUrl: snapshotId => `${DOWNLOAD_API}/api/snapshots/${snapshotId}/json-package`,

  createAiPreparation: payload => jsonFetch('/api/ai-preparations', { method:'POST', body:JSON.stringify(payload) }),
  latestAiPreparation: snapshotId => jsonFetch(`/api/snapshots/${snapshotId}/latest-ai-preparation`),
  aiPreparationExportUrl: id => `${DOWNLOAD_API}/api/ai-preparations/${id}/export`,

  createChatSession: snapshotId => jsonFetch('/api/chat-sessions', {method:'POST',body:JSON.stringify({snapshotId})}),
  getChatSession: id => jsonFetch(`/api/chat-sessions/${id}`),
  latestChatSession: snapshotId => jsonFetch(`/api/snapshots/${snapshotId}/latest-chat-session`),
  answerChat: (id,payload) => jsonFetch(`/api/chat-sessions/${id}/answer`,{method:'POST',body:JSON.stringify(payload)}),
  analyzeChat: id => jsonFetch(`/api/chat-sessions/${id}/analyze`,{method:'POST',body:'{}'}),
  chatMessages: id => jsonFetch(`/api/chat-sessions/${id}/messages`),
  chatFollowup: (id,message) => jsonFetch(`/api/chat-sessions/${id}/followup`,{method:'POST',body:JSON.stringify({message})}),
  analysisVersions: (area,obra,base='GO') => jsonFetch(`/api/projects/${encodeURIComponent(area)}/${encodeURIComponent(obra)}/${encodeURIComponent(base)}/analysis-versions`),

  getAiAnalysis: id => jsonFetch(`/api/ai-analyses/${id}`),
  aiEventsUrl: id => `${API}/api/ai-analyses/${id}/events`,
  aiPreparedResultUrl: id => `${DOWNLOAD_API}/api/ai-analyses/${id}/result`,
  aiHtmlViewUrl: id => `${DOWNLOAD_API}/api/ai-analyses/${id}/html`,
  aiHtmlDownloadUrl: id => `${DOWNLOAD_API}/api/ai-analyses/${id}/html?download=1`,
  aiOutputPackageUrl: id => `${DOWNLOAD_API}/api/ai-analyses/${id}/output-package`,
  aiOutputFileUrl: (id,kind) => `${DOWNLOAD_API}/api/ai-analyses/${id}/output-file/${encodeURIComponent(kind)}`,
};
