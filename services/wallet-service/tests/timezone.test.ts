import { getVnDay, getVnMonthKey } from '../src/utils/timezone.helper';
import assert from 'assert';

// Test time
function runTimezoneTests() {
  console.log('--- Testing Timezone Helper (GMT+7) ---');

  // Test 1: Giờ bình thường trong ngày
  const normalDate = new Date('2026-10-25T05:00:00Z'); // 12:00 VN
  assert.strictEqual(getVnDay(normalDate), '2026-10-25');
  assert.strictEqual(getVnMonthKey(normalDate), '2026-10');

  // Test 2: Biên ngày GMT+7 lúc 23:59:59 (16:59:59 UTC)
  const dateBeforeMidnight = new Date('2026-10-25T16:59:59Z');
  assert.strictEqual(getVnDay(dateBeforeMidnight), '2026-10-25');
  assert.strictEqual(getVnMonthKey(dateBeforeMidnight), '2026-10');

  // Test 3: Biên ngày GMT+7 lúc 00:01:00 (17:01:00 UTC)
  const dateAfterMidnight = new Date('2026-10-25T17:01:00Z');
  assert.strictEqual(getVnDay(dateAfterMidnight), '2026-10-26');
  assert.strictEqual(getVnMonthKey(dateAfterMidnight), '2026-10');

  // Test 4: Biên chuyển giao tháng lúc 23:59:59 ngày 31/10 (16:59:59 UTC)
  const endOfMonth = new Date('2026-10-31T16:59:59Z');
  assert.strictEqual(getVnDay(endOfMonth), '2026-10-31');
  assert.strictEqual(getVnMonthKey(endOfMonth), '2026-10');

  // Test 5: Biên chuyển giao tháng lúc 00:01:00 ngày 01/11 (17:01:00 UTC)
  const startOfNewMonth = new Date('2026-10-31T17:01:00Z');
  assert.strictEqual(getVnDay(startOfNewMonth), '2026-11-01');
  assert.strictEqual(getVnMonthKey(startOfNewMonth), '2026-11');

  // Test 6: Biên chuyển giao năm 31/12 -> 01/01
  const endOfYear = new Date('2026-12-31T16:59:59Z');
  assert.strictEqual(getVnDay(endOfYear), '2026-12-31');
  assert.strictEqual(getVnMonthKey(endOfYear), '2026-12');

  const startOfNewYear = new Date('2026-12-31T17:00:01Z');
  assert.strictEqual(getVnDay(startOfNewYear), '2027-01-01');
  assert.strictEqual(getVnMonthKey(startOfNewYear), '2027-01');

  console.log('✅ PASS: All timezone tests passed successfully!');
}

runTimezoneTests();
