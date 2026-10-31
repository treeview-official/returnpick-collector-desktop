import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SOURCE_URL, TAB_SELECTOR, CARD_SELECTOR, normalizeProduct, initialize, step, close } from '../src/engine/specials.mjs';

const raw = (id, extras = {}) => ({ id, itemId: id + 100, vendorItemId: id + 200, title: `상품 ${id}`,
  imagePath: `vendor_inventory/${id}.jpg`, priceInfo: { discountedPrice: 0, originalPrice: 10000, discountRate: 100, discountedDescription: '와우쿠폰할인' },
  ratingInfo: { ratingAverage: 4.5, ratingCount: 123 }, properties: { promotion_remaining_time_ms: '60000', privateExtra: 'must-not-export' },
  badges: [{ id: 'ROCKET_MERCHANT', type: 'SHIPPINGTYPE', text: '판매자로켓' }], stockPercentageBucket: 75, ...extras });

test('normalization preserves listing meaning without credentials, exact-stock guesses or WOW-delivery guesses', () => {
  const row = normalizeProduct(raw(1), '2026-10-31T00:00:00.000Z');
  assert.equal(row.listedPrice, 0);
  assert.equal(row.promotionEndAtEstimated, '2026-10-31T00:01:00.000Z');
  assert.equal(row.remainingPercentBucket, 75);
  assert.equal(row.soldPercent, null); assert.equal(row.remainingStock, null);
  assert.deepEqual(row.deliveryTypes, ['판매자로켓']);
  assert.equal(row.originalUrl, 'https://www.coupang.com/vp/products/1?itemId=101&vendorItemId=201');
  assert.ok(!JSON.stringify(row).includes('must-not-export'));
  const unknown = normalizeProduct(raw(2, { properties: {}, stockPercentageBucket: null, ratingInfo: {} }), '2026-10-31T00:00:00Z');
  assert.equal(unknown.remainingPercentBucket, null); assert.equal(unknown.ratingValue, null);
  assert.equal(unknown.promotionEndAtEstimated, null);
  assert.equal(normalizeProduct(raw(3, { vendorItemId: null }), '2026-10-31T00:00:00Z'), null);
});

class Page extends EventEmitter {
  constructor({ broken = false } = {}) {
    super(); this.names = ['전체', '시간임박', '신규특가']; this.active = 0; this.top = 0; this.height = 300;
    this.rounds = 0; this.rows = []; this.closed = false; this.broken = broken; this.clicks = []; this.wheels = [];
    this.mouse = { wheel: async (_x, pixels) => {
      this.wheels.push(pixels); this.top = Math.min(this.top + pixels, this.height - 100); this.rounds++;
      // A delayed second batch at the bottom must reset the stable-bottom counter.
      if (this.active === 0 && this.rounds === 3) { this.rows.push(raw(2)); this.height += 200; this.respond(); }
    } };
  }
  respond() {
    const rows = [...this.rows], category = `CAT_${this.active}`;
    this.emit('response', { url: () => 'https://www.coupang.com/np/omp/api/getPromotion', status: () => this.broken ? 503 : 200,
      categoryKey: () => category, requestStartedAt: () => Date.now(),
      json: async () => ({ data: { promotionData: rows, token: 'private-continuation-state' } }) });
  }
  async goto() { this.active = 0; this.rows = [raw(1)]; this.respond(); }
  url() { return SOURCE_URL; }
  async route() {} async setViewportSize() {} isClosed() { return this.closed; } async close() { this.closed = true; }
  locator(selector) {
    const page = this;
    return {
      nth(index) { return { async click() {
        page.clicks.push(page.names[index]); page.active = index; page.top = 0; page.height = 300; page.rounds = 0;
        page.rows = index === 1 ? [raw(2), raw(3)] : []; page.respond();
      } }; },
      last() { return this; },
      async evaluateAll() {
        if (selector === TAB_SELECTOR) return page.names.map((name, index) => ({ name, selected: index === page.active }));
        if (selector === CARD_SELECTOR) return page.rows.map(x => ({ title: x.title, deliveryMessage: '내일 도착', deliveryDisplay: '무료배송', remainingPercentDisplay: '75% 남음' }));
        return [];
      }
    };
  }
}
const config = { sourceUrl: SOURCE_URL, pauseMs: 3000, scrollPixels: 650, bottomStableRounds: 3, maxActions: 200, maxRunMinutes: 30, closeTabOnFinish: true, sleep: async () => {} };
const helpersFor = page => ({
  inspect: async () => `Scroll Y: size=${page.height} client=100 overflowing=true top=${page.top}`,
  snapshot: async () => '', getLatestLogs: async () => []
});
async function setup(dir, page, seedFile) {
  return initialize({ context: { newPage: async () => page }, config, helpers: helpersFor(page), checkpointFile: path.join(dir, 'specials.json'), runId: 'test-specials', seedFile });
}

test('visits every tab, waits for late batches, deduplicates across tabs and verifies an empty tab', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'returnpick-specials-')), page = new Page();
  try {
    const job = await setup(dir, page);
    while (job.status === 'running') await step(job);
    await close(job);
    const saved = JSON.parse(fs.readFileSync(job.checkpointFile));
    assert.equal(saved.collectionComplete, true); assert.equal(saved.productCount, 3);
    assert.deepEqual(page.clicks, ['시간임박', '신규특가']);
    assert.deepEqual(saved.products.find(x => x.productId === '2').sections, ['전체', '시간임박']);
    assert.equal(saved.coverage.categoriesComplete, 3);
    assert.equal(saved.coverage.categories[2].productCount, 0);
    assert.ok(saved.coverage.categories.every(x => x.bottomStableRounds >= 3));
    assert.ok(page.wheels.every(x => x <= 650));
    assert.ok(!JSON.stringify(saved).includes('private-continuation-state'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stop/resume preserves products and finished tabs while restarting the unfinished tab', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'returnpick-specials-'));
  try {
    const page = new Page(), job = await setup(dir, page);
    while (!job.tabs.get('전체').complete) await step(job);
    await step(job); // Switch to the unfinished second tab.
    fs.writeFileSync(path.join(dir, 'stop'), 'stop'); await step(job); await close(job, true);
    const partial = JSON.parse(fs.readFileSync(job.checkpointFile));
    assert.equal(partial.collectionComplete, false); assert.equal(partial.coverage.categoriesComplete, 1);
    fs.rmSync(path.join(dir, 'stop'));
    const next = new Page(), resumed = await setup(dir, next, job.checkpointFile);
    while (resumed.status === 'running') await step(resumed);
    await close(resumed);
    assert.equal(resumed.status, 'complete'); assert.equal(resumed.products.size, 3);
    assert.ok(!next.wheels.length || next.clicks[0] === '시간임박');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed listing responses cannot become a successful empty collection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'returnpick-specials-'));
  try { await assert.rejects(setup(dir, new Page({ broken: true })), /목록 응답/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed next batch preserves existing products and remains partial', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'returnpick-specials-')), page = new Page();
  try {
    const job = await setup(dir, page);
    page.broken = true; page.respond();
    await Promise.resolve(); await Promise.resolve(); await step(job); await close(job, true);
    const saved = JSON.parse(fs.readFileSync(job.checkpointFile));
    assert.equal(saved.collectionComplete, false); assert.equal(saved.productCount, 1);
    assert.equal(saved.stopReason, 'listing_network_error');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
