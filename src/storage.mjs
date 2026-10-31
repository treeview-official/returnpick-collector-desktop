import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
}
export function csvText(rows) {
  const fields = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => '"' + (value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll('"', '""') + '"';
  return '\uFEFF' + [fields.map(cell).join(','), ...rows.map(row => fields.map(field => cell(row[field])).join(','))].join('\r\n');
}
export function saveExport(root, source, data) {
  if (!['returns', 'goldbox'].includes(source) || !/^[\w-]+$/.test(data.runId)) throw new Error('잘못된 저장 정보입니다.');
  const base = path.join(root, source);
  const runFolder = path.join(base, data.runId);
  fs.mkdirSync(runFolder, { recursive: true });
  writeJson(path.join(runFolder, 'products.json'), data);
  const csv = csvText(data.products || []);
  fs.writeFileSync(path.join(runFolder, 'products.csv'), csv, 'utf8');
  writeJson(path.join(base, 'latest.json'), data);
  fs.writeFileSync(path.join(base, 'latest.csv.tmp'), csv, 'utf8');
  fs.renameSync(path.join(base, 'latest.csv.tmp'), path.join(base, 'latest.csv'));
  if (data.collectionComplete) writeJson(path.join(base, 'latest-complete.json'), data);
  return runFolder;
}
