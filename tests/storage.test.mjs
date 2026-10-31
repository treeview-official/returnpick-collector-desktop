import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, saveExport, csvText } from '../src/storage.mjs';

test('partial exports do not replace the last complete snapshot or another source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'returnpick-storage-'));
  try {
    const complete = { runId: 'run-1', collectionComplete: true, products: [{ title: '완료' }] };
    saveExport(dir, 'returns', complete);
    saveExport(dir, 'goldbox', { ...complete, runId: 'gold-1', products: [{ title: '골드박스' }] });
    saveExport(dir, 'specials', { ...complete, runId: 'specials-1', products: [{ title: '판매자특가', sections: ['전체', '시간임박'] }] });
    saveExport(dir, 'returns', { ...complete, runId: 'run-2', collectionComplete: false, products: [{ title: '부분' }] });
    assert.equal(readJson(path.join(dir, 'returns', 'latest-complete.json')).products[0].title, '완료');
    assert.equal(readJson(path.join(dir, 'returns', 'latest.json')).products[0].title, '부분');
    assert.equal(readJson(path.join(dir, 'goldbox', 'latest.json')).products[0].title, '골드박스');
    assert.deepEqual(readJson(path.join(dir, 'specials', 'latest.json')).products[0].sections, ['전체', '시간임박']);
    assert.ok(fs.existsSync(path.join(dir, 'returns', 'run-1', 'products.csv')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('CSV preserves Korean, commas, quotes, nested fields, zero and unknowns', () => {
  const csv = csvText([{ title: '한국어, "인용"', price: 0, grade: null, tags: ['최상', '상'] }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"한국어, ""인용"""'));
  assert.ok(csv.includes('"0","","[""최상"",""상""]"'));
});
test('export destinations cannot escape their source folder', () => {
  assert.throws(() => saveExport('unused', '../escape', { runId: 'run' }));
  assert.throws(() => saveExport('unused', 'returns', { runId: '../../escape' }));
});
