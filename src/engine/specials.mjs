import fs from 'node:fs';
import path from 'node:path';
import { productKey } from './browser.mjs';

export const SOURCE_URL = 'https://www.coupang.com/np/omp';
export const CARD_SELECTOR = '[class*="styles_promotion_item__"]';
export const TAB_SELECTOR = '[class*="styles_category_item__"]';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = job => (job.config.sleep || sleep)(job.config.pauseMs);
const numeric = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const id = value => value != null && /^\d+$/.test(String(value)) ? String(value) : null;
const isListing = url => { try { const u = new URL(url); return u.origin === 'https://www.coupang.com' && u.pathname === '/np/omp/api/getPromotion'; } catch { return false; } };

export function normalizeProduct(value, observedAt) {
  const productId = id(value.id), itemId = id(value.itemId), vendorItemId = id(value.vendorItemId);
  if (!productId || !itemId || !vendorItemId || typeof value.title !== 'string') return null;
  const url = new URL(`https://www.coupang.com/vp/products/${productId}`);
  url.searchParams.set('itemId', itemId); url.searchParams.set('vendorItemId', vendorItemId);
  let imageUrl = null;
  if (typeof value.imagePath === 'string') {
    if (/^https:\/\/[^/]+\.coupangcdn\.com\//.test(value.imagePath)) imageUrl = value.imagePath;
    else if (!/^(?:https?:|\/\/)/.test(value.imagePath)) imageUrl = `https://thumbnail6.coupangcdn.com/thumbnails/remote/292x292q65ex/image/${value.imagePath.replace(/^\/?image\//, '').replace(/^\//, '')}`;
  }
  const price = value.priceInfo || {}, rating = value.ratingInfo || {};
  const remainingMs = numeric(value.properties?.promotion_remaining_time_ms);
  const bucket = numeric(value.stockPercentageBucket);
  const badges = (Array.isArray(value.badges) ? value.badges : []).filter(b => /SHIPPING|DELIVERY/.test(b.type || '')).map(b => ({ id: String(b.id || ''), text: typeof b.text === 'string' ? b.text : '' }));
  const deliveryTypes = [];
  for (const badge of badges) {
    if (/FRESH/.test(badge.id)) deliveryTypes.push('프레쉬');
    else if (/GLOBAL|OVERSEAS|JIKGU/.test(badge.id)) deliveryTypes.push('직구');
    else if (/ROCKET_MERCHANT/.test(badge.id)) deliveryTypes.push('판매자로켓');
    else if (/WOW/.test(badge.id)) deliveryTypes.push('로켓와우');
    else if (/ROCKET/.test(badge.id)) deliveryTypes.push('로켓배송');
  }
  return {
    sourceKey: 'specials', productId, itemId, vendorItemId, title: value.title, imageUrl,
    originalUrl: url.href, listedPrice: numeric(price.discountedPrice ?? price.salesPrice),
    listedOriginalPrice: numeric(price.originalPrice), listedDiscountPercent: numeric(price.discountRate),
    pricePromotionLabel: typeof price.discountedDescription === 'string' ? price.discountedDescription : null,
    ratingValue: numeric(rating.ratingAverage), ratingScale: 5, reviewCount: numeric(rating.ratingCount),
    reviewCountDisplay: rating.ratingCount == null ? null : String(rating.ratingCount),
    remainingSecondsAtObservation: remainingMs == null ? null : Math.max(0, Math.floor(remainingMs / 1000)),
    promotionEndAtEstimated: remainingMs == null ? null : new Date(Date.parse(observedAt) + Math.max(0, remainingMs)).toISOString(),
    timerSource: remainingMs == null ? null : 'listing_response',
    remainingPercentDisplay: bucket == null ? null : `${bucket}% 남음`, remainingPercentBucket: bucket,
    remainingStock: null, soldPercent: null, deliveryBadges: badges, deliveryTypes: [...new Set(deliveryTypes)],
    soldOut: typeof value.soldOut === 'boolean' ? value.soldOut : null,
    conditionLabels: [], displayedOfferCount: null, usedLowestPrice: null, sections: [],
    observedAt, firstObservedAt: observedAt,
  };
}

export function mergeListingProduct(previous, incoming, tabName) {
  return { ...previous, ...incoming, firstObservedAt: previous?.firstObservedAt || incoming.observedAt,
    sections: [...new Set([...(previous?.sections || []), ...(incoming.sections || []), tabName])] };
}
function tab(job, name) {
  if (!job.tabs.has(name)) job.tabs.set(name, { name, complete: false, responses: 0, scrollActions: 0, bottomStableRounds: 0, keys: new Set() });
  return job.tabs.get(name);
}
function fail(job, message) {
  job.errors.push(message); job.status = 'partial'; job.stopReason = message;
}
function attach(job) {
  job.responseHandler = response => {
    if (!isListing(response.url())) return;
    let categoryKey, startedAt;
    // Only public category and timing metadata are read from a request. Never retain its body/headers.
    if (response.categoryKey) { categoryKey = response.categoryKey(); startedAt = response.requestStartedAt(); }
    else {
      try { categoryKey = response.request().postDataJSON()?.query?.SMART_CATEGORY; startedAt = response.request().timing().startTime; } catch {}
    }
    const receivedAt = new Date().toISOString();
    const current = job.currentTab;
    const target = job.categoryNames.get(categoryKey) || ((startedAt == null || startedAt >= job.tabRequestedAt) ? current : null);
    if (!target) return;
    const pending = (async () => {
      if (response.status() !== 200) throw new Error('판매자특가 상품 목록 응답 오류');
      const data = await response.json();
      if (!Array.isArray(data?.data?.promotionData)) throw new Error('판매자특가 상품 목록 형식 변경');
      const record = tab(job, target);
      if (categoryKey) job.categoryNames.set(categoryKey, target);
      record.responses++; record.lastResponseAt = receivedAt;
      for (const value of data.data.promotionData) {
        const row = normalizeProduct(value, receivedAt);
        if (!row) { record.invalidRows = (record.invalidRows || 0) + 1; continue; }
        const key = productKey(row);
        record.keys.add(key);
        job.products.set(key, mergeListingProduct(job.products.get(key), row, target));
      }
      // data.token and unrelated product properties are intentionally not retained.
    })().catch(() => { job.networkErrors++; }).finally(() => job.busyResponses.delete(pending));
    job.busyResponses.add(pending);
  };
  job.requestFailureHandler = request => { if (isListing(request.url())) job.networkErrors++; };
  job.page.on('response', job.responseHandler);
  job.page.on('requestfailed', job.requestFailureHandler);
}
async function drain(job) {
  if (!job.busyResponses.size) return;
  let timer;
  const finished = await Promise.race([Promise.all([...job.busyResponses]).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]).finally(() => clearTimeout(timer));
  if (!finished) throw new Error('판매자특가 상품 응답 대기 시간 초과');
}
async function discover(job) {
  const tabs = await job.page.locator(TAB_SELECTOR).evaluateAll(nodes => nodes.map(node => ({ name: node.textContent.trim(), selected: [...node.classList].some(c => c.startsWith('styles_selected__')) })).filter(x => x.name));
  if (!tabs.length || !tabs.some(t => t.name === '전체')) throw new Error('판매자특가 탭 구조를 확인하지 못했습니다.');
  for (const item of tabs) tab(job, item.name);
  job.tabOrder = tabs.map(t => t.name);
  const selected = tabs.filter(t => t.selected);
  if (selected.length !== 1) throw new Error('선택된 판매자특가 탭을 확인하지 못했습니다.');
  return selected[0].name;
}
async function measure(job) {
  const info = await job.helpers.inspect({ locator: job.page.locator('html') });
  const match = /Scroll Y: size=(\d+) client=(\d+) overflowing=\w+ top=([\d.]+)/.exec(info);
  if (!match) throw new Error('판매자특가 스크롤 위치를 읽지 못했습니다.');
  return job.position = { height: +match[1], viewport: +match[2], top: +match[3] };
}
async function captureDom(job) {
  if (job.page.url() !== SOURCE_URL) throw new Error('판매자특가 목록을 벗어났습니다.');
  if (await discover(job) !== job.currentTab) throw new Error('수집 중 판매자특가 탭이 변경되었습니다.');
  const cards = await job.page.locator(CARD_SELECTOR).evaluateAll(nodes => nodes.map(node => {
    const text = part => node.querySelector(`[class*="${part}"]`)?.textContent?.trim() || null;
    return { title: text('styles_item_title__'), deliveryMessage: text('styles_pdd_text__'), deliveryDisplay: text('styles_delivery_info__'), remainingPercentDisplay: text('styles_progress_text__') };
  }));
  const record = tab(job, job.currentTab);
  record.domCards = cards.length;
  const byTitle = new Map(cards.filter(x => x.title).map(x => [x.title, x]));
  for (const key of record.keys) {
    const row = job.products.get(key), visible = byTitle.get(row.title);
    if (visible) Object.assign(row, visible, { seenInDom: true });
  }
  // Zero products is legitimate only after a successfully decoded listing response.
  if (!cards.length && !record.responses) throw new Error('판매자특가 목록이 없습니다. 접근 상태를 확인해주세요.');
}
async function feedback(job) {
  await job.helpers.snapshot({ page: job.page, locator: job.page.locator(CARD_SELECTOR).last() });
  await job.helpers.getLatestLogs({ page: job.page, sinceLastCall: true, count: 1 });
}
async function switchTab(job, name) {
  const current = await discover(job), record = tab(job, name);
  job.currentTab = name; job.tabRequestedAt = Date.now();
  record.responses = 0; record.bottomStableRounds = 0; record.invalidRows = 0;
  if (current !== name) {
    const index = job.tabOrder.indexOf(name);
    await job.page.locator(TAB_SELECTOR).nth(index).click();
    await wait(job); await feedback(job);
  }
  await drain(job);
  for (let attempt = 0; attempt < 5 && !record.responses; attempt++) { await wait(job); await drain(job); }
  if (!record.responses) throw new Error(`${name} 탭에서 상품 목록 응답을 확인하지 못했습니다.`);
  await captureDom(job); await measure(job);
  job.lastAction = `${name} 탭 수집 시작 · ${job.tabOrder.indexOf(name) + 1}/${job.tabOrder.length}`;
}
export function checkpoint(job) {
  const products = [...job.products.values()];
  const categories = [...job.tabs.values()].map(({ keys, ...record }) => ({ ...record, productCount: keys.size }));
  const result = { sourceKey: 'specials', sourceUrl: SOURCE_URL, runId: job.runId, startedAt: job.startedAt,
    updatedAt: new Date().toISOString(), finishedAt: job.finishedAt || null, status: job.status,
    collectionComplete: job.status === 'complete', productCount: products.length, actions: job.actions,
    currentTab: job.currentTab, position: job.position, stopReason: job.stopReason || null, errors: job.errors,
    partnersApiCalled: false, coverage: { categories, categoriesComplete: categories.filter(t => t.complete).length, categoriesTotal: categories.length },
    notes: ['판매자특가의 각 탭에서 정상 스크롤로 불러온 목록만 수집합니다.', '상품/옵션 중복을 제거하고 sections에 발견한 탭을 저장합니다.', '남음 비율은 표시 구간값이며 정확한 재고나 판매율로 환산하지 않습니다.', '남은 시간은 응답 관측 당시 값이며 예상 종료 시각과 함께 저장합니다.', '원본 링크만 저장하며 상세페이지는 열지 않습니다.'], products };
  fs.mkdirSync(path.dirname(job.checkpointFile), { recursive: true });
  fs.writeFileSync(job.checkpointFile + '.tmp', JSON.stringify(result, null, 2), 'utf8');
  fs.renameSync(job.checkpointFile + '.tmp', job.checkpointFile);
  return { status: job.status, count: products.length, actions: job.actions, lastAction: job.lastAction,
    categoriesVisited: result.coverage.categoriesComplete, categoriesTotal: categories.length };
}
export async function initialize({ context, config, helpers, checkpointFile, runId, seedFile }) {
  if (config.sourceUrl !== SOURCE_URL) throw new Error('검증된 판매자특가 주소만 지원합니다.');
  const job = { page: await context.newPage(), config, helpers, checkpointFile, runId, startedAt: new Date().toISOString(),
    products: new Map(), tabs: new Map(), tabOrder: [], categoryNames: new Map(), busyResponses: new Set(),
    currentTab: '전체', tabRequestedAt: Date.now(), actions: 0, status: 'running', errors: [], networkErrors: 0, lastAction: '판매자특가 목록 열기' };
  try {
    if (seedFile && fs.existsSync(seedFile)) {
      const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      if (seed.sourceUrl !== SOURCE_URL || seed.collectionComplete) throw new Error('판매자특가 이어 수집 결과가 없습니다.');
      for (const row of seed.products) job.products.set(productKey(row), row);
      for (const saved of seed.coverage?.categories || []) Object.assign(tab(job, saved.name), saved, { keys: new Set() });
      for (const [key, row] of job.products) for (const name of row.sections || []) tab(job, name).keys.add(key);
    }
    tab(job, '전체').responses = 0;
    attach(job);
    await job.page.route(/^https:\/\/(?:www|trip)\.coupang\.com\/(?:vp|tp)\/products\//, route => route.request().isNavigationRequest() ? route.abort() : route.continue());
    await job.page.setViewportSize({ width: 1600, height: 1000 });
    await job.page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await wait(job); await feedback(job); await drain(job);
    for (let attempt = 0; attempt < 6 && !tab(job, '전체').responses; attempt++) { await wait(job); await drain(job); }
    if (!tab(job, '전체').responses || job.networkErrors) throw new Error('판매자특가 목록 응답을 확인하지 못했습니다. 접근 상태를 확인해주세요.');
    await captureDom(job); await measure(job);
    // Keep only currently exposed tabs in coverage when resuming after a site change.
    for (const name of job.tabs.keys()) if (!job.tabOrder.includes(name)) job.tabs.delete(name);
    checkpoint(job); return job;
  } catch (error) {
    job.page.off('response', job.responseHandler); job.page.off('requestfailed', job.requestFailureHandler);
    if (!job.page.isClosed()) await job.page.close(); throw error;
  }
}
export async function step(job, limit = 1) {
  for (let i = 0; i < limit && job.status === 'running'; i++) {
    if (fs.existsSync(path.join(path.dirname(job.checkpointFile), 'stop'))) { fail(job, 'user_stop'); break; }
    if (job.actions >= job.config.maxActions || Date.now() - Date.parse(job.startedAt) >= job.config.maxRunMinutes * 60000) { fail(job, 'configured_limit'); break; }
    if (job.networkErrors) { fail(job, 'listing_network_error'); break; }
    const record = tab(job, job.currentTab);
    if (record.complete) {
      const next = job.tabOrder.find(name => !tab(job, name).complete);
      if (!next) { job.status = 'complete'; job.stopReason = 'all_tabs_stable_bottom_verified'; job.finishedAt = new Date().toISOString(); break; }
      await switchTab(job, next); job.actions++; checkpoint(job); continue;
    }
    const before = job.position || await measure(job), count = record.keys.size, responses = record.responses;
    await job.page.mouse.wheel(0, Math.min(job.config.scrollPixels, Math.floor(before.viewport * .8)));
    await wait(job); await drain(job); await captureDom(job);
    const after = await measure(job);
    const stable = after.top + after.viewport >= after.height - 12 && Math.abs(after.height - before.height) < 4 && Math.abs(after.top - before.top) < 4 && count === record.keys.size && responses === record.responses;
    record.bottomStableRounds = stable ? record.bottomStableRounds + 1 : 0;
    record.scrollActions++; job.actions++;
    job.lastAction = `${record.name} · ${record.keys.size}개 · 바닥 확인 ${record.bottomStableRounds}/${job.config.bottomStableRounds} · 완료 ${[...job.tabs.values()].filter(t => t.complete).length}/${job.tabOrder.length}탭`;
    if (record.bottomStableRounds >= job.config.bottomStableRounds) {
      if (record.invalidRows || job.networkErrors || !record.responses || record.keys.size < record.domCards) fail(job, 'listing_coverage_not_verified');
      else { record.complete = true; record.completedAt = new Date().toISOString(); }
    }
    await feedback(job); checkpoint(job);
  }
  return checkpoint(job);
}
export async function close(job, interrupted = false) {
  if (interrupted && job.status === 'running') { job.status = 'partial'; job.stopReason = 'user_stop_or_error'; }
  await drain(job);
  job.finishedAt ||= new Date().toISOString();
  job.page.off('response', job.responseHandler); job.page.off('requestfailed', job.requestFailureHandler);
  const result = checkpoint(job);
  if (job.config.closeTabOnFinish && !job.page.isClosed()) await job.page.close();
  return result;
}
