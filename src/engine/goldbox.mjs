import fs from 'node:fs';
import path from 'node:path';
import { money, productKey } from './browser.mjs';

export const SOURCE_URL = 'https://www.coupang.com/mlp/web/mlp-landing-page?landingId=3712&sourceType=gm_crm_goldbox&subSourceType=gm_crm_gwsrtcut';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const detailPattern=/^https:\/\/(?:www|trip)\.coupang\.com\/(?:vp|tp)\/products\//;
async function guardDetails(job) {
  if(job.guardOptimized) return;
  // Keep ordinary listing/image requests out of the routing round trip.
  await job.page.unroute('**/*');
  await job.page.route(detailPattern,route=>route.request().isNavigationRequest() ? route.abort() : route.continue());
  job.guardOptimized=true;
}
async function prepareDesktop(job) {
  if(job.viewportPrepared) return;
  // Use the same desktop card layout regardless of the window active at launch.
  await job.page.setViewportSize({width:1600,height:1000});
  job.position=null;
  job.viewportPrepared=true;
}

export function parseReviewCount(value) {
  const display = value?.replace(/[()]/g,'').trim() || null;
  const lower = display?.match(/[\d,]+/)?.[0];
  const exact = lower ? !display.includes('+') : null;
  return {reviewCountDisplay:display,reviewCount:exact ? money(lower) : null,reviewCountLowerBound:lower ? money(lower) : null,reviewCountExact:exact};
}
export function parseTimer(value, observedAt) {
  const clock = value?.match(/(\d+)\s*:\s*(\d{2})\s*:\s*(\d{2})/);
  const seconds = clock ? Number(clock[1])*3600+Number(clock[2])*60+Number(clock[3]) : null;
  return {remainingTimeDisplay:value || null,remainingSecondsAtObservation:seconds,promotionEndAtEstimated:seconds != null ? new Date(Date.parse(observedAt)+seconds*1000).toISOString() : null,timerSource:seconds != null ? 'visible_countdown' : null};
}
export function deliveryTypes(badgeUrl) {
  if(!badgeUrl) return [];
  if(/fresh/i.test(badgeUrl)) return ['프레쉬'];
  if(/global|jikgu|overseas/i.test(badgeUrl)) return ['직구'];
  if(/wow/i.test(badgeUrl)) return ['로켓와우'];
  if(/rocket_merchant/i.test(badgeUrl)) return ['판매자로켓'];
  if(/rocket|logo_rocket/i.test(badgeUrl)) return ['로켓배송'];
  return [];
}
const httpsImage = value => value?.replace(/^http:\/\/(.*\.coupangcdn\.com\/)/,'https://$1') || null;

async function capture(job) {
  if(job.page.url() !== SOURCE_URL) throw new Error('골드박스 목록을 벗어나 수집을 중단했습니다.');
  const rows = await job.page.locator('.m-product-item').evaluateAll(cards => cards.map(card => {
    const link=card.querySelector('a[data-product-link="true"]');
    if(!link || !/\/(?:vp|tp)\/products\/\d+/.test(link.href)) return null;
    let fiber=card[Object.keys(card).find(key=>key.startsWith('__reactFiber$'))], data;
    for(let i=0;fiber&&i<20;i++,fiber=fiber.return) if(fiber.memoizedProps?.data?.productId){data=fiber.memoizedProps.data;break;}
    const text=selector=>card.querySelector(selector)?.textContent?.trim()||null;
    const url=new URL(link.href);
    return {
      productId:url.pathname.match(/\/products\/(\d+)/)?.[1],itemId:url.searchParams.get('itemId'),vendorItemId:url.searchParams.get('vendorItemId'),
      title:data ? [data.starBrandInfo?.brandName,data.productTitle].filter(Boolean).join(' ') : text('.m-product-title'),
      imageUrl:data?.productImageUrl || card.querySelector('.m-product-item__image img')?.src,
      listedPrice:data?.finalPrice?.value || text('.final-price__number'),listedOriginalPrice:data?.originalPrice || text('.original-price'),
      listedDiscountPercent:data?.instantDiscount?.value || text('.instant-discount__badge'),
      soldPercentDisplay:text('.m-product-item__progress-bar__text'),soldProgressRatio:data?.marketingInfo?.saleProgress?.percent ?? null,
      remainingTimeDisplay:text('.m-product-cart-promotion-timer'),initialCountdownMillis:data?.marketingInfo?.promotionTimer?.countDownMillis ?? null,
      reviewCountDisplay:data?.reviewRating?.text || text('.rds-rating__content'),ratingValue:data?.reviewRating?.value ?? null,
      deliveryBadgeUrl:data?.deliveryBadgeUrl || null,deliveryMessage:data?.pdd?.label || text('.delivery-arrival-message'),
      pricePromotionLabel:data?.finalPrice?.text || text('.final-price__text'),soldOut:data?.stockRemainingInfo?.isSoldOut ?? null,
      originalUrl:link.href,observedAt:new Date().toISOString(),sourceKey:'goldbox',conditionLabels:[],displayedOfferCount:null,usedLowestPrice:null,remainingStock:null,sections:[],seenInDom:true,
    };
  }).filter(Boolean));
  for(const row of rows) {
    row.imageUrl=httpsImage(row.imageUrl); row.deliveryBadgeUrl=httpsImage(row.deliveryBadgeUrl);
    row.listedPrice=money(row.listedPrice); row.listedOriginalPrice=money(row.listedOriginalPrice); row.listedDiscountPercent=money(row.listedDiscountPercent);
    const sold=row.soldPercentDisplay?.match(/([\d.]+)\s*%/)?.[1];
    row.soldPercent=sold==null ? null : Number(sold);
    Object.assign(row,parseReviewCount(row.reviewCountDisplay),parseTimer(row.remainingTimeDisplay,row.observedAt));
    if(row.ratingValue === 0 && !row.reviewCountDisplay) row.ratingValue = null;
    row.deliveryTypes=deliveryTypes(row.deliveryBadgeUrl); row.ratingScale=5;
    const key=productKey(row), previous=job.products.get(key);
    job.products.set(key,{...row,firstObservedAt:previous?.firstObservedAt || row.observedAt});
  }
  job.domCards=rows.length;
}
async function measure(job) {
  const info=await job.helpers.inspect({locator:job.page.locator('html')});
  const match=/Scroll Y: size=(\d+) client=(\d+) overflowing=\w+ top=([\d.]+)/.exec(info);
  if(!match) throw new Error('골드박스 스크롤 상태를 읽지 못했습니다.');
  job.position={height:Number(match[1]),viewport:Number(match[2]),top:Number(match[3])};
  return job.position;
}
export function checkpoint(job) {
  const products=[...job.products.values()];
  const fields=['soldPercent','remainingSecondsAtObservation','ratingValue','reviewCountDisplay','deliveryBadgeUrl'];
  const missing=Object.fromEntries(fields.map(field=>[field,products.filter(p=>p[field]==null).length]));
  const snapshot={sourceKey:'goldbox',sourceUrl:SOURCE_URL,runId:job.runId,startedAt:job.startedAt,updatedAt:new Date().toISOString(),finishedAt:job.finishedAt||null,status:job.status,collectionComplete:job.status==='complete',productCount:products.length,actions:job.actions,position:job.position,stopReason:job.stopReason||null,errors:job.errors,partnersApiCalled:false,missing,coverage:{bottomStableRounds:job.bottomStable,domCards:job.domCards,categories:[],carousels:[]},notes:['상세페이지를 열지 않고 골드박스 전체 목록을 천천히 순회했습니다.','판매율은 화면 표시값이며 수집 시점 기준입니다.','후기 9,999+는 정확한 개수가 아닙니다. 원문과 하한값을 함께 저장합니다.','남은 시간은 수집 시점의 타이머이며 종료 예상 시각은 초 단위로 추정됩니다.','배송 배지가 없는 상품은 유형을 추정하지 않습니다. 와우할인 문구만으로 배송 유형을 판단하지 않습니다.'],products};
  fs.mkdirSync(path.dirname(job.checkpointFile),{recursive:true});
  fs.writeFileSync(job.checkpointFile+'.tmp',JSON.stringify(snapshot,null,2),'utf8');fs.renameSync(job.checkpointFile+'.tmp',job.checkpointFile);
  return {status:job.status,count:products.length,actions:job.actions,lastAction:job.lastAction,categoriesVisited:0,categoriesTotal:0,missing};
}
export async function initialize({context,config,helpers,checkpointFile,runId,seedFile}) {
  if(config.sourceUrl!==SOURCE_URL) throw new Error('검증된 골드박스 주소만 지원합니다.');
  const job={page:await context.newPage(),config,helpers,checkpointFile,runId,products:new Map(),status:'running',startedAt:new Date().toISOString(),actions:0,bottomStable:0,errors:[],lastAction:'골드박스 목록 열기'};
  try{
    if(seedFile&&fs.existsSync(seedFile)){const seed=JSON.parse(fs.readFileSync(seedFile,'utf8'));if(seed.sourceUrl!==SOURCE_URL||seed.collectionComplete)throw new Error('골드박스 이어 수집 결과가 없습니다.');for(const row of seed.products)job.products.set(productKey(row),row);}
    await guardDetails(job);
    await prepareDesktop(job);
    await job.page.goto(SOURCE_URL,{waitUntil:'domcontentloaded',timeout:30000});
    await helpers.waitForPageLoad({page:job.page,timeout:8000});await sleep(config.pauseMs);
    await helpers.snapshot({page:job.page,search:/골드박스|판매됨/});
    await helpers.getLatestLogs({page:job.page,sinceLastCall:true,count:3});
    if(!await job.page.locator('.m-product-item').count())throw new Error('골드박스 목록이 없습니다. 접근 제한이나 로그인 상태를 확인해주세요.');
    await measure(job);await capture(job);checkpoint(job);return job;
  }catch(error){if(!job.page.isClosed())await job.page.close();throw error;}
}
export async function step(job,limit=5) {
  await guardDetails(job);
  await prepareDesktop(job);
  for(let i=0;i<limit&&job.status==='running';i++){
    if(fs.existsSync(path.join(path.dirname(job.checkpointFile),'stop'))){job.status='partial';job.stopReason='user_stop';break;}
    if(job.actions>=job.config.maxActions||Date.now()-Date.parse(job.startedAt)>=job.config.maxRunMinutes*60000){job.status='partial';job.stopReason='configured_limit';break;}
    const before=job.position || await measure(job), count=job.products.size;
    await job.page.mouse.wheel(0,Math.min(job.config.scrollPixels,Math.floor(before.viewport*.8)));
    await sleep(job.config.pauseMs);
    const after=await measure(job);await capture(job);
    const bottom=after.top+after.viewport>=after.height-12;
    job.bottomStable=bottom&&Math.abs(after.height-before.height)<4&&Math.abs(after.top-before.top)<4&&job.products.size===count?job.bottomStable+1:0;
    job.actions++;job.lastAction=`골드박스 아래로 천천히 스크롤 · 바닥 확인 ${job.bottomStable}/${job.config.bottomStableRounds}`;
    if(job.bottomStable>=job.config.bottomStableRounds){job.status='complete';job.stopReason='stable_bottom_verified';job.finishedAt=new Date().toISOString();}
    checkpoint(job);
  }
  await job.helpers.snapshot({page:job.page,locator:job.page.locator('.m-product-item').last(),search:/판매됨|남음/});
  await job.helpers.getLatestLogs({page:job.page,sinceLastCall:true,count:1});
  return checkpoint(job);
}
export async function close(job,interrupted=false) {
  if(interrupted&&job.status==='running'){job.status='partial';job.stopReason='user_stop_or_error';}
  job.finishedAt ||= new Date().toISOString();const result=checkpoint(job);
  if(job.config.closeTabOnFinish&&!job.page.isClosed())await job.page.close();return result;
}
