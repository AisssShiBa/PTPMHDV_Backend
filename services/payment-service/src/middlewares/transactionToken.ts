import { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { verifyPaymentToken } from '../utils/transaction-token';
import { DomainException } from '../utils/domain.exception';

export interface TransactionTokenPayload {
  iss: string;
  aud: string;
  sub: string;
  paymentId: string;
  amount: string;
  jti: string;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      transactionToken?: TransactionTokenPayload;
    }
  }
}

// Nạp Public Key của Auth Service.
export function getAuthTxnPublicKey(): string {
  const fileEnv = process.env.AUTH_TXN_PUBLIC_KEY_FILE;
  if (fileEnv && fs.existsSync(fileEnv)) {
    return fs.readFileSync(fileEnv, 'utf8').trim();
  }

  const directKey = process.env.AUTH_TXN_PUBLIC_KEY?.trim();
  if (directKey) {
    return directKey;
  }

  // Fallback to local files if present
  const candidates = [
    path.resolve(process.cwd(), 'secrets/auth_txn_public.pem'),
    path.resolve(process.cwd(), '../../secrets/auth_txn_public.pem'),
    path.resolve(__dirname, '../../../../secrets/auth_txn_public.pem'),
    '/run/secrets/auth_txn_public_key'
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8').trim();
    }
  }

  throw new Error('AUTH_TXN_PUBLIC_KEY is not configured or secret file not found');
}

export const requireTransactionToken = (req: Request, res: Response, next: NextFunction) => {
  // 1. Lấy token từ header và body kiểm ra với nhau.
  const headerToken = req.headers['x-transaction-token'];
  const bodyToken = req.body?.transactionToken;
  if (headerToken && bodyToken && headerToken !== bodyToken) {
    return res.status(403).json({ success: false, error: { code: 'TXN_TOKEN_MISMATCH', message: 'Header and body tokens differ' } });
  }
  const token = headerToken || bodyToken;

  if (!token || typeof token !== 'string') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing X-Transaction-Token header'
      }
    });
  }

  let publicKey: string;
  try {
    //2. Lấy khóa Public Key
    publicKey = getAuthTxnPublicKey();
  } catch (err: any) {
    console.error('Failed to load AUTH_TXN_PUBLIC_KEY:', err);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Authentication configuration error'
      }
    });
  }

  try {
    //3. Xác thực mật mã bất đối xứng.
    const claims = verifyPaymentToken(token, publicKey);

    //4. Kiểm tra cấu trúc PayLoad (Claims) phải đủ 4 thông tin định danh:
    // - sub: UUID của người dùng.
    // - paymentId: UUID của giao dịch cần thanh toán.
    // - amount: Số tiền thanh toán.
    // - jti: Mã định danh duy nhất của token
    if (!claims.sub || !claims.paymentId || !claims.amount || !claims.jti) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INVALID_TRANSACTION_TOKEN',
          message: 'Invalid transaction token claims'
        }
      });
    }

    // Gắn vào Request Context và chuyển tiếp
    req.transactionToken = { ...claims, iss: 'finvault-auth-service', aud: 'finvault-payment-service' };
    return next();
  } catch (error: any) {
    if (error instanceof DomainException) {
      return res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'TRANSACTION_TOKEN_EXPIRED',
          message: 'Transaction token expired'
        }
      });
    }

    return res.status(403).json({
      success: false,
      error: {
        code: 'INVALID_TRANSACTION_TOKEN',
        message: 'Invalid transaction token'
      }
    });
  }
};

