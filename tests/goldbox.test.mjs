import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReviewCount,parseTimer,deliveryTypes} from '../src/engine/goldbox.mjs';

test('capped reviews never become an invented exact count',()=>{
  assert.deepEqual(parseReviewCount('(9,999+)'),{reviewCountDisplay:'9,999+',reviewCount:null,reviewCountLowerBound:9999,reviewCountExact:false});
  assert.equal(parseReviewCount('(1,443)').reviewCount,1443);
  assert.equal(parseReviewCount(null).reviewCount,null);
});
test('observed countdown produces an estimated deadline instead of a stale duration',()=>{
  const timer=parseTimer('18:30:01남음','2026-10-31T03:00:00Z');
  assert.equal(timer.remainingSecondsAtObservation,66601);
  assert.equal(timer.promotionEndAtEstimated,'2026-10-31T21:30:01.000Z');
  assert.equal(parseTimer(null,'2026-10-31T03:00:00Z').promotionEndAtEstimated,null);
});
test('delivery comes from actual badges and not discount wording',()=>{
  assert.deepEqual(deliveryTypes('logo_fresh_medium.png'),['프레쉬']);
  assert.deepEqual(deliveryTypes('logo_jikgu_medium.png'),['직구']);
  assert.deepEqual(deliveryTypes('logo_rocket_medium.png'),['로켓배송']);
  assert.deepEqual(deliveryTypes('logo_wow_medium.png'),['로켓와우']);
  assert.deepEqual(deliveryTypes('logo_rocket_merchant_medium_v3_r3.png'),['판매자로켓']);
  assert.deepEqual(deliveryTypes(null),[]);
});
