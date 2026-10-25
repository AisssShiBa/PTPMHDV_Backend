/**
 * Timezone helper for Vietnam (GMT+7 / Asia/Ho_Chi_Minh).
 * Vietnam does not observe daylight saving time, maintaining a constant UTC+7 offset.
 * Tại sao không dùng giờ quốc tế UTC?
  - Vì giờ quốc tế UTC không được sử dụng ở Việt Nam.
  - Giờ Việt Nam là GMT+7.
  - Tối ưu hóa ứng dụng dùng cho người Việt.
*/

// Lấy ngày theo giờ Việt Nam
export function getVnDay(date: Date = new Date()): string {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

// Lấy tháng theo giờ Việt Nam
export function getVnMonthKey(date: Date = new Date()): string {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(d);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;

  return `${year}-${month}`;
}
