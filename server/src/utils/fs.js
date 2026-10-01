import fs from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

export async function walkDirectories(root, { maxDepth = 8, targetName } = {}) {
  const result = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (!targetName || entry.name.toLowerCase() === targetName.toLowerCase()) result.push(full);
      await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return result;
}

export async function walkFiles(root, { maxDepth = 50 } = {}) {
  const files = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('~$') || entry.name === '.DS_Store') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(root, 0);
  return files;
}

export function normalizePathForDisplay(p) {
  return p.replaceAll('\\', '/');
}
