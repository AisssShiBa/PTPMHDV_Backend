import { Request, Response } from 'express';
import { DomainException } from '../../utils/domain.exception';
import { CashOutService } from '../services/cashout.service';
import { MockPayoutService } from '../services/mock-payout.service';
import { mockPayoutEnabled } from '../services/mock-payout.service';

const cashOutService = new CashOutService();
const mockPayoutService = new MockPayoutService();

// Never echo the bank account, the PIN, the token or internal keys.
// failureReason is included because it is an error code, not free-form PII.
function view(cashOut: any) {
  return {
    id: cashOut.id,
    userId: cashOut.userId,
    amount: cashOut.amount?.toFixed ? cashOut.amount.toFixed(0) : String(cashOut.amount),
    destination: cashOut.destination ?? null,
    status: cashOut.status,
    failureReason: cashOut.failureReason ?? null,
    createdAt: cashOut.createdAt,
    updatedAt: cashOut.updatedAt,
    ...(cashOut.replayed === undefined ? {} : { replayed: cashOut.replayed }),
  };
}

function idempotencyKey(req: Request, bodyKey?: string): string {
  const headerKey = req.get('Idempotency-Key');
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw new DomainException(400, 'IDEMPOTENCY_KEY_MISMATCH', 'Header and body keys differ');
  }
  const key = headerKey || bodyKey;
  if (!key) throw new DomainException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
  if (key.length > 255) throw new DomainException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is too long');
  return key;
}

export const create = async (req: Request, res: Response) => {
  const { cashOut, replayed } = await cashOutService.create({
    userId: req.auth!.userId,
    idempotencyKey: idempotencyKey(req),
    amount: req.body.amount,
    destination: req.body.destination,
  });
  res.status(201).json({ success: true, data: view({ ...cashOut, replayed }) });
};

export const confirm = async (req: Request, res: Response) => {
  const result = await cashOutService.confirm(
    req.params.id as string,
    req.auth!.userId,
    req.transactionToken!,
  );
  if (!result) throw new DomainException(503, 'CASHOUT_PROCESSING', 'Cash-out is being processed; query its status');
  if (result.status === 'FAILED') {
    throw new DomainException(409, 'CASHOUT_FAILED', result.failureReason || 'Cash-out failed');
  }
  if (result.status === 'PAYOUT_PENDING') {
    throw new DomainException(503, 'CASHOUT_PAYOUT_PENDING', 'Payout outcome is being reconciled; query its status');
  }
  res.json({ success: true, data: view(result) });
};

export const getById = async (req: Request, res: Response) => {
  const result = await cashOutService.get(req.params.id as string, req.auth!.userId, req.auth!.role);
  res.json({ success: true, data: view(result) });
};

// ---- internal mock payout routes: never proxied publicly ----

function assertMockEnabled() {
  if (!mockPayoutEnabled()) {
    throw new DomainException(404, 'MOCK_PAYOUT_DISABLED', 'Mock payout is not enabled');
  }
}

export const mockPayoutQuery = async (req: Request, res: Response) => {
  assertMockEnabled();
  const row = await mockPayoutService.query(req.params.providerRef as string);
  if (!row) throw new DomainException(404, 'PAYOUT_NOT_FOUND', 'Payout not found');
  res.json({ success: true, data: row });
};

export const mockPayoutResolve = async (req: Request, res: Response) => {
  assertMockEnabled();
  const row = await mockPayoutService.resolve(req.params.providerRef as string, req.body.result);
  res.json({ success: true, data: row });
};
