import { config } from '../config.js';
import { listEnabledSyncSchedules, markScheduleRunFinished, markScheduleRunStarted } from '../db/syncScheduleRepository.js';
import { startIncrementalSync, waitForJob } from './syncService.js';

let timer=null;
let running=false;
let lastTickAt=null;

function partsInZone(date,timezone){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const map=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return {date:`${map.year}-${map.month}-${map.day}`,time:`${map.hour}:${map.minute}`,minutes:Number(map.hour)*60+Number(map.minute)};
}
function minutesOf(t){const [h,m]=String(t).split(':').map(Number);return h*60+m;}
function dueSlot(schedule,now=new Date()){
  const local=partsInZone(now,schedule.timezone||config.autoSync.timezone);
  const grace=config.autoSync.graceMinutes;
  let candidate=null;
  for(const time of schedule.times||[]){
    const delta=local.minutes-minutesOf(time);
    if(delta<0 || delta>grace) continue;
    const runKey=`${local.date}|${time}`;
    if(schedule.lastRunKey===runKey) continue;
    if(!candidate || minutesOf(time)>minutesOf(candidate.time)) candidate={runKey,time,delta,local};
  }
  return candidate;
}

async function runSchedule(schedule,slot){
  try{
    const {job}=startIncrementalSync({area:schedule.area,obra:schedule.obra,projectBase:schedule.projectBase,trigger:'scheduled'});
    markScheduleRunStarted({area:schedule.area,obra:schedule.obra,projectBase:schedule.projectBase,runKey:slot.runKey,jobId:job.id});
    const done=await waitForJob(job.id);
    markScheduleRunFinished({area:schedule.area,obra:schedule.obra,projectBase:schedule.projectBase,jobId:job.id,status:done.status,error:done.error||null});
  }catch(error){
    console.error(`[AUTO SYNC ${schedule.area}/${schedule.obra}/${schedule.projectBase}]`,error);
    markScheduleRunFinished({area:schedule.area,obra:schedule.obra,projectBase:schedule.projectBase,jobId:null,status:'failed',error:error.message});
  }
}

export async function schedulerTick(){
  if(running) return;
  running=true; lastTickAt=new Date().toISOString();
  try{
    for(const schedule of listEnabledSyncSchedules()){
      const slot=dueSlot(schedule);
      if(slot) void runSchedule(schedule,slot);
    }
  }finally{running=false;}
}

export function startAutoSyncScheduler(){
  if(timer || !config.autoSync.enabled) return;
  void schedulerTick();
  timer=setInterval(()=>void schedulerTick(),config.autoSync.pollSeconds*1000);
  timer.unref?.();
}
export function stopAutoSyncScheduler(){ if(timer){clearInterval(timer);timer=null;} }
export function autoSyncDiagnostics(){return {enabled:config.autoSync.enabled,pollSeconds:config.autoSync.pollSeconds,graceMinutes:config.autoSync.graceMinutes,timezone:config.autoSync.timezone,running,lastTickAt};}
