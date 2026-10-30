import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';

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
  const token = req.headers['x-transaction-token'];

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
    const claims = jwt.verify(token, publicKey, {
      algorithms: ['ES256'],
      issuer: 'finvault-auth-service',
      audience: 'finvault-payment-service',
    }) as TransactionTokenPayload;

    if (!claims.sub || !claims.paymentId || !claims.amount || !claims.jti) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INVALID_TRANSACTION_TOKEN',
          message: 'Invalid transaction token claims'
        }
      });
    }

    req.transactionToken = claims;
    return next();
  } catch (error: any) {
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

