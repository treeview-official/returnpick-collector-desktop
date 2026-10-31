import test from 'node:test';
import assert from 'node:assert/strict';
import { money, parseUsedSummary, productKey, mergeProduct } from '../src/engine/browser.mjs';

test('offer count is kept separate from stock and review count', () => {
  assert.deepEqual(parseUsedSummary('새 상품, 반품 - 최상, 반품 - 상 (9)최저15,010원'), {
    conditionLabels: ['새 상품', '반품 - 최상', '반품 - 상'], displayedOfferCount: 9,
    usedLowestPrice: 15010, remainingStock: null,
  });
  assert.equal(parseUsedSummary(null).displayedOfferCount, null);
  assert.equal(parseUsedSummary('반품 - 중 (1,234)').displayedOfferCount, 1234);
});
test('dedup preserves options and ignores tracking parameters', () => {
  const a = { productId: '1', itemId: '2', vendorItemId: '3', originalUrl: 'https://www.coupang.com/vp/products/1?sourceType=a' };
  assert.equal(productKey(a), productKey({ ...a, originalUrl: 'https://www.coupang.com/vp/products/1?sourceType=b' }));
  assert.notEqual(productKey(a), productKey({ ...a, vendorItemId: '4' }));
});
test('virtualized cards cannot erase previously loaded images or first-seen time', () => {
  const previous = { imageUrl: 'https://example.com/a.jpg', listedPrice: 10000, firstObservedAt: 'first', sections: ['a'] };
  const merged = mergeProduct(previous, { imageUrl: null, listedPrice: 9000, observedAt: 'later', sections: ['b'] });
  assert.equal(merged.imageUrl, previous.imageUrl);
  assert.equal(merged.listedPrice, 9000);
  assert.equal(merged.firstObservedAt, 'first');
  assert.deepEqual(merged.sections, ['a', 'b']);
  assert.equal(merged.remainingStock, null);
});
test('missing prices stay missing and zero is preserved', () => {
  assert.equal(money(null), null);
  assert.equal(money(''), null);
  assert.equal(money('0원'), 0);
  assert.equal(money('1,234원'), 1234);
});
