import { DomainException } from './domain.exception';

export interface KeysetCursor {
  createdAt: Date;
  id: bigint;
}

export function encodeCursor(entry: { createdAt: Date; id: bigint | string | number }): string {
  const payload = JSON.stringify({
    createdAt: entry.createdAt.toISOString(),
    id: entry.id.toString(),
  });
  return Buffer.from(payload, 'utf-8').toString('base64url');
}

export function decodeCursor(cursorStr: string): KeysetCursor {
  try {
    const jsonStr = Buffer.from(cursorStr, 'base64url').toString('utf-8');
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid cursor object');
    }
    const { createdAt, id } = parsed;
    if (!createdAt || typeof createdAt !== 'string' || id === undefined || id === null) {
      throw new Error('Missing cursor fields');
    }
    const date = new Date(createdAt);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date in cursor');
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new Error('Invalid id type');
    }
    if (typeof id === 'string' && !/^\d+$/.test(id)) {
      throw new Error('Invalid numeric id in cursor');
    }
    const bigintId = BigInt(id);
    return { createdAt: date, id: bigintId };
  } catch (err: any) {
    throw new DomainException(400, 'INVALID_CURSOR', 'Cursor phân trang không hợp lệ');
  }
}
