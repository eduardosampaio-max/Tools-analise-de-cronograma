import { createJob, getJob, listJobs, updateJob } from '../analysis/jobManager.js';
import { normalizeProjectBase } from '../domain/projectBase.js';

function keyOf(area,obra,base){ return `${String(area).toUpperCase()}::${String(obra).toLowerCase()}::${normalizeProjectBase(base)}`; }
function active(job){ return job && ['queued','processing'].includes(job.status); }

export function findActiveSync({area,obra,projectBase='GO'}){
  const key=keyOf(area,obra,projectBase);
  return listJobs().find(job=>job.kind==='extraction' && active(job) && keyOf(job.area,job.obra,job.projectBase||'GO')===key) || null;
}

export function startIncrementalSync({area,obra,projectBase='GO',retryPartial=false,trigger='manual'}){
  const base=normalizeProjectBase(projectBase);
  const existing=findActiveSync({area,obra,projectBase:base});
  if(existing) return {job:existing,deduplicated:true};
  const job=createJob({kind:'extraction',area:String(area).toUpperCase(),obra:String(obra),projectBase:base,retryPartial:Boolean(retryPartial),aiUsed:false,trigger});
  setImmediate(async()=>{
    try{
      const {runExtraction}=await import('../extraction/extractCronograma.js');
      await runExtraction(job);
    }catch(error){
      console.error('[SYNC SERVICE]',error);
      updateJob(job.id,{status:'failed',progress:100,stage:'Falha ao carregar extratores',error:error.message});
    }
  });
  return {job,deduplicated:false};
}

export async function waitForJob(jobId,{timeoutMs=8*60*60*1000,pollMs=750}={}){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    const job=getJob(jobId);
    if(!job) throw new Error(`Job ${jobId} não encontrado.`);
    if(['completed','partial','failed'].includes(job.status)) return job;
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  throw new Error(`Tempo limite aguardando sincronização ${jobId}.`);
}
