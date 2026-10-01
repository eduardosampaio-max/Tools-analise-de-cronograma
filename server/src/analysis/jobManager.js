import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const jobs = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(100);

export function createJob(payload) {
  const id = crypto.randomUUID();
  const job = {
    id, ...payload, status:'queued', stage:'Na fila', progress:0,
    totalFiles:0, processedFiles:0, files:[], result:null, error:null,
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
  };
  jobs.set(id, job);
  emit(job);
  return job;
}

export function getJob(id) { return jobs.get(id); }
export function listJobs() { return [...jobs.values()]; }
export function updateJob(id, patch) {
  const current = jobs.get(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt:new Date().toISOString() };
  jobs.set(id, next); emit(next); return next;
}
export function subscribe(id, fn) {
  const event = `job:${id}`;
  bus.on(event, fn);
  return () => bus.off(event, fn);
}
function emit(job) { bus.emit(`job:${job.id}`, job); }
