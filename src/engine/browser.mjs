import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_URL = 'https://pages.coupang.com/p/54908';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const money = value => value == null || value === '' ? null : Number(String(value).replace(/[^0-9]/g, ''));
export function productKey(product) {
  if (product.vendorItemId) return `${product.productId || ''}:${product.itemId || ''}:${product.vendorItemId}`;
  const url = new URL(product.originalUrl);
  return `${url.pathname}:${url.searchParams.get('itemId') || ''}:${url.searchParams.get('vendorItemId') || ''}`;
}
export function parseUsedSummary(summary) {
  const text = summary || '';
  return {
    conditionLabels: text.match(/새 상품|박스 훼손|재포장|(?:반품|중고)\s*-\s*(?:최상|상|중|하)/g) || [],
    displayedOfferCount: money(text.match(/\(([\d,]+)\)/)?.[1]),
    usedLowestPrice: money(text.match(/최저\s*([\d,]+)\s*원/)?.[1]),
    remainingStock: null,
  };
}
export function mergeProduct(previous, incoming) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length)) merged[key] = value;
    else if (!(key in merged)) merged[key] = value;
  }
  merged.firstObservedAt = previous?.firstObservedAt || incoming.observedAt;
  merged.sections = [...new Set([...(previous?.sections || []), ...(incoming.sections || [])])];
  merged.remainingStock = null;
  return merged;
}

async function capture(job) {
  if (job.page.url().split('#')[0] !== SOURCE_URL) throw new Error(`목록을 벗어나 수집을 중단했습니다: ${job.page.url()}`);
  const rows = await job.page.locator('.product-unit-info__title').evaluateAll(titles => titles.map(title => {
    const card = title.closest('a');
    if (!card || !/\/vp\/products\/\d+/.test(card.href)) return null;
    const txt = selector => card.querySelector(selector)?.textContent?.trim() || null;
    const num = value => value == null || value === '' ? null : Number(value.replace(/[^0-9]/g, ''));
    const url = new URL(card.href);
    const summary = txt('.product-unit-used-product');
    const percentage = txt('.discount-price__percentage')?.match(/(\d+)\s*%/);
    const image = Array.from(card.querySelectorAll('.product-unit-thumbnail img')).find(el => el.getAttribute('alt') !== '이동' && !/\.svg(?:\?|$)/.test(el.src));
    return {
      productId: url.pathname.match(/\/products\/(\d+)/)?.[1] || null,
      itemId: url.searchParams.get('itemId'), vendorItemId: url.searchParams.get('vendorItemId'),
      title: title.textContent.trim(), imageUrl: image?.src || null,
      listedPrice: num(txt('.current-price__price')),
      listedOriginalPrice: num(txt('.discount-price__base-price')),
      listedDiscountPercent: percentage ? Number(percentage[1]) : null,
      usedOfferSummary: summary, originalUrl: card.href,
      sections: [card.closest('[id^="widget_"]')?.id].filter(Boolean),
      observedAt: new Date().toISOString(), seenInDom: true,
    };
  }).filter(Boolean));
  for (const row of rows) {
    Object.assign(row, parseUsedSummary(row.usedOfferSummary));
    const network = job.networkProducts.get(row.vendorItemId);
    if (network) {
      row.listedPrice ??= money(network.priceArea?.price ?? network.priceArea?.salesPrice);
      row.listedOriginalPrice ??= money(network.priceArea?.basePrice ?? network.priceArea?.originalPrice);
      row.listedDiscountPercent ??= network.priceArea?.discountRate ?? null;
      row.imageUrl ||= network.imageAndTitleArea?.defaultUrl ? new URL(network.imageAndTitleArea.defaultUrl, SOURCE_URL).href : null;
      row.soldOut = network.soldoutArea?.soldout ?? null;
    }
    const key = productKey(row);
    job.products.set(key, mergeProduct(job.products.get(key), row));
  }
  job.domCards = rows.length;
  if (!job.categories.size) {
    const targets = await job.page.locator('a[href^="#widget_"]').evaluateAll(links => links.map(el => ({ id: el.getAttribute('href').slice(1), name: el.textContent.trim() })).filter(x => x.name));
    for (const target of targets) job.categories.set(target.id, { ...job.categories.get(target.id), ...target });
  }
  for (const row of rows) for (const id of row.sections) {
    if (job.categories.has(id)) job.categories.get(id).visited = true;
  }
}

async function measure(job) {
  const info = await job.helpers.inspect({ locator: job.page.locator('html') });
  const match = /Scroll Y: size=(\d+) client=(\d+) overflowing=\w+ top=([\d.]+)/.exec(info);
  if (!match) throw new Error('목록 스크롤 위치를 읽을 수 없습니다.');
  const result = { height: Number(match[1]), viewport: Number(match[2]), top: Number(match[3]) };
  job.viewportHeight = result.viewport;
  job.position = result;
  return result;
}

async function carouselState(locator, title = '상품 목록') {
  const nav = await locator.locator('.carousel-header__nav').textContent();
  const numbers = nav?.match(/(\d+)\s*\/\s*(\d+)/);
  return { title, current: numbers ? Number(numbers[1]) : 1, total: numbers ? Number(numbers[2]) : 1 };
}

async function nextCarousel(job) {
  const carousels = job.page.locator('.carousel');
  const metadata = await carousels.evaluateAll(items => items.map(el => ({
    title: el.querySelector('.carousel-header__title')?.textContent?.trim() || '상품 목록',
    nav: el.querySelector('.carousel-header__nav')?.textContent || '1/1',
  })));
  for (let index = 0; index < metadata.length; index++) {
    const locator = carousels.nth(index);
    const numbers = metadata[index].nav.match(/(\d+)\s*\/\s*(\d+)/);
    const current = { title: metadata[index].title, current: Number(numbers?.[1] || 1), total: Number(numbers?.[2] || 1) };
    const record = job.carousels.get(current.title) || { title: current.title, total: current.total, pages: [], failures: 0 };
    record.total = Math.max(record.total, current.total);
    record.pages = [...new Set([...record.pages, current.current])].sort((a,b)=>a-b);
    job.carousels.set(current.title, record);
    if (record.complete || record.failed || current.current >= current.total) {
      record.complete = !record.failed && record.pages.length >= record.total;
      continue;
    }
    const info = await job.helpers.inspect({ locator });
    const box = /Box: x=(-?[\d.]+) y=(-?[\d.]+) w=([\d.]+) h=([\d.]+)/.exec(info);
    if (!box || Number(box[2]) >= job.viewportHeight || Number(box[2]) + Number(box[4]) < 0) continue;
    return { locator, before: current, record };
  }
  return null;
}

function exportState(job) {
  const products = [...job.products.values()];
  const missing = { image: 0, price: 0, title: 0 };
  for (const product of products) {
    if (!product.imageUrl) missing.image++;
    if (product.listedPrice == null) missing.price++;
    if (!product.title) missing.title++;
  }
  return {
    sourceUrl: SOURCE_URL, runId: job.runId, startedAt: job.startedAt,
    updatedAt: new Date().toISOString(), finishedAt: job.finishedAt || null,
    collectionComplete: job.status === 'complete', status: job.status,
    scope: '지정된 반품마켓 페이지에서 정상 목록 조작으로 노출된 상품. 쿠팡 전체 반품 재고를 의미하지 않음.',
    partnersApiCalled: false, productCount: products.length, actions: job.actions,
    position: job.position, missing, stopReason: job.stopReason || null,
    errors: job.errors || [],
    attempts: job.attempts || [],
    coverage: { bottomStableRounds: job.bottomStable, categories: [...job.categories.values()], carousels: [...job.carousels.values()] },
    notes: ['상세페이지를 열지 않고 목록만 수집했습니다.', 'displayedOfferCount는 목록의 표시 개수이며 실제 재고로 확정하지 않습니다.', '대표 가격·취소선 가격·반품 최저가를 분리합니다. 등급별 개별 가격은 목록에 없으면 추정하지 않습니다.'],
    products,
  };
}
export function checkpoint(job) {
  fs.mkdirSync(path.dirname(job.checkpointFile), { recursive: true });
  const data = exportState(job);
  const temp = `${job.checkpointFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, job.checkpointFile);
  return { status: job.status, count: data.productCount, actions: job.actions, position: job.position, phase: job.phase, lastAction: job.lastAction, missing: data.missing, carousels: data.coverage.carousels.map(c=>({title:c.title,current:c.pages.length,total:c.total,complete:!!c.complete})), categoriesVisited: data.coverage.categories.filter(c=>c.visited).length, categoriesTotal: job.categories.size };
}

export async function initialize({ context, config, helpers, checkpointFile, runId, seedFile }) {
  if (config.sourceUrl !== SOURCE_URL) throw new Error('이 수집기는 검증된 반품마켓 URL만 지원합니다.');
  const job = { page: await context.newPage(), config, helpers, checkpointFile, runId, startedAt: new Date().toISOString(), products: new Map(), networkProducts: new Map(), categories: new Map(), carousels: new Map(), errors: [], actions: 0, bottomStable: 0, viewportHeight: 900, phase: '목록 수집', status: 'running', lastAction: '목록 열기', busyResponses: new Set() };
  try {
  job.attemptStartedAt = new Date().toISOString();
  job.attempts = [{ startedAt: job.attemptStartedAt }];
  if (seedFile && fs.existsSync(seedFile)) {
    const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    if (seed.sourceUrl !== SOURCE_URL || seed.collectionComplete) throw new Error('이어 수집할 부분 결과가 없습니다.');
    job.startedAt = seed.startedAt;
    job.actions = seed.actions || 0;
    job.attempts = [...(seed.attempts || [{ startedAt: seed.startedAt }]), { startedAt: job.attemptStartedAt }];
    for (const product of seed.products || []) job.products.set(productKey(product), product);
    for (const carousel of seed.coverage?.carousels || []) job.carousels.set(carousel.title, { ...carousel, failed: false, failures: 0 });
  }
  job.attemptStartActions = job.actions;
  job.responseHandler = response => {
    const url = new URL(response.url());
    const listingApi = url.origin === 'https://pages.coupang.com' && (url.pathname.startsWith('/api/products') || url.pathname.startsWith('/api/parts/'));
    if (!listingApi) return;
    if (response.status() >= 400) {
      job.errors.push(`목록 응답 오류: HTTP ${response.status()} ${url.pathname}`);
      job.status = 'partial'; job.stopReason = 'listing_http_error'; job.finishedAt = new Date().toISOString();
      return;
    }
    if (!url.pathname.startsWith('/api/products')) return;
    const pending = response.json().then(data => {
      for (const [key, value] of Object.entries(data || {})) if (value && typeof value === 'object' && value.vendorItemId) job.networkProducts.set(String(value.vendorItemId || key), value);
    }).catch(() => {}).finally(()=>job.busyResponses.delete(pending));
    job.busyResponses.add(pending);
  };
  job.page.on('response', job.responseHandler);
  job.requestFailedHandler = request => {
    const url = new URL(request.url());
    if (url.origin === 'https://pages.coupang.com' && (url.pathname.startsWith('/api/products') || url.pathname.startsWith('/api/parts/'))) {
      job.errors.push(`목록 요청 실패: ${url.pathname}`);
      job.status = 'partial'; job.stopReason = 'listing_network_error'; job.finishedAt = new Date().toISOString();
    }
  };
  job.page.on('requestfailed', job.requestFailedHandler);
  // Block accidental navigation to product details while allowing ordinary list resources.
  await job.page.route('**/*', route => {
    const request = route.request();
    if (request.isNavigationRequest() && request.frame() === job.page.mainFrame() && new URL(request.url()).pathname.startsWith('/vp/products/')) return route.abort();
    return route.continue();
  });
  await job.page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await helpers.waitForPageLoad({ page: job.page, timeout: 8000 });
  await sleep(Math.max(2500, config.pauseMs));
  let observed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await helpers.snapshot({ page: job.page, search: /반품마켓|다음 상품 보기/ }); observed = true; break; }
    catch (error) { if (attempt === 2) throw error; await sleep(2500); }
  }
  if (!observed || !await job.page.locator('.product-unit-info__title').count()) throw new Error('상품 목록이 없습니다. Chrome에서 접근 제한·로그인 상태를 확인해주세요.');
  await measure(job);
  await capture(job);
  await helpers.getLatestLogs({ page: job.page, sinceLastCall: true, count: 2 });
  checkpoint(job);
  return job;
  } catch (error) {
    if (job.responseHandler) job.page.off('response', job.responseHandler);
    if (job.requestFailedHandler) job.page.off('requestfailed', job.requestFailedHandler);
    if (!job.page.isClosed()) await job.page.close();
    throw error;
  }
}

export async function step(job, limit = 6) {
  for (let count = 0; count < limit && job.status === 'running'; count++) {
    if (fs.existsSync(path.join(path.dirname(job.checkpointFile), 'stop'))) {
      job.status = 'partial'; job.stopReason = 'user_stop'; job.finishedAt = new Date().toISOString(); break;
    }
    if (job.actions - (job.attemptStartActions || 0) >= job.config.maxActions || Date.now() - Date.parse(job.attemptStartedAt || job.startedAt) >= job.config.maxRunMinutes * 60000) {
      job.status = 'partial'; job.stopReason = 'configured_limit'; break;
    }
    await measure(job);
    const carousel = await nextCarousel(job);
    const beforeCount = job.products.size;
    if (carousel) {
      job.lastAction = `${carousel.before.title} ${carousel.before.current + 1}/${carousel.before.total}`;
      try {
        await carousel.locator.getByRole('button', { name: '다음 상품 보기', exact: true }).click({ timeout: 12000 });
      } catch (error) {
        // Observe the actual page after a timeout; the click may already have advanced it.
        await job.helpers.snapshot({ page: job.page, search: /dialog|alert|오류|차단|확인|닫기/ });
        await job.helpers.getLatestLogs({ page: job.page, sinceLastCall: true, count: 3 });
        if (!/Timeout/i.test(error.message)) throw error;
      }
      await sleep(job.config.pauseMs);
      await capture(job);
      const after = await carouselState(carousel.locator, carousel.before.title);
      carousel.record.pages = [...new Set([...carousel.record.pages, after.current])].sort((a,b)=>a-b);
      if (after.current === carousel.before.current) carousel.record.failures++;
      else carousel.record.failures = 0;
      if (carousel.record.failures >= 3) { carousel.record.failed = true; job.errors.push(`${after.title}: 페이지 이동 실패`); }
      carousel.record.complete = carousel.record.pages.length >= carousel.record.total;
      job.bottomStable = 0;
    } else {
      job.lastAction = '아래로 천천히 스크롤';
      const before = job.position;
      const distance = Math.min(job.config.scrollPixels, Math.max(50, Math.floor(job.viewportHeight * 0.8)));
      await job.page.mouse.wheel(0, distance);
      await sleep(job.config.pauseMs);
      const after = await measure(job);
      await capture(job);
      const atBottom = after.top + after.viewport >= after.height - 12;
      const stable = atBottom && Math.abs(after.height - before.height) < 4 && Math.abs(after.top - before.top) < 4 && job.products.size === beforeCount;
      job.bottomStable = stable ? job.bottomStable + 1 : 0;
      if (job.bottomStable >= job.config.bottomStableRounds) {
        // Empty category sections also count as visited once their position is verified at the end.
        for (const [id, category] of job.categories) if (!category.visited) {
          const target = job.page.locator(`[id="${id}"]`);
          if (await target.count()) {
            const info = await job.helpers.inspect({ locator: target });
            const box = /Box: x=(-?[\d.]+) y=(-?[\d.]+) w=([\d.]+) h=([\d.]+)/.exec(info);
            if (box && Number(box[2]) + Number(box[4]) >= 0 && Number(box[2]) < job.viewportHeight) category.visited = true;
          }
        }
        const unfinished = [...job.carousels.values()].filter(c=>!c.complete);
        const unvisited = [...job.categories.values()].filter(c=>!c.visited);
        job.status = unfinished.length || unvisited.length || job.errors.length || job.categories.size < 13 || job.carousels.size < 4 ? 'partial' : 'complete';
        job.stopReason = job.status === 'complete' ? 'bottom_and_carousels_verified' : 'coverage_incomplete';
        job.finishedAt = new Date().toISOString();
      }
    }
    job.actions++;
    await job.helpers.getLatestLogs({ page: job.page, sinceLastCall: true, count: 1 });
    checkpoint(job);
  }
  return checkpoint(job);
}

export async function close(job, interrupted = false) {
  if (interrupted && job.status === 'running') { job.status = 'partial'; job.stopReason = 'user_stop_or_error'; job.finishedAt = new Date().toISOString(); }
  await Promise.allSettled([...job.busyResponses]);
  const result = checkpoint(job);
  job.page.off('response', job.responseHandler);
  if (job.requestFailedHandler) job.page.off('requestfailed', job.requestFailedHandler);
  if (job.config.closeTabOnFinish && !job.page.isClosed()) await job.page.close();
  return result;
}
