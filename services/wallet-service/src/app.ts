import 'express-async-errors';
import './config/env';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import walletRoutes from './routes/wallet.routes';
import adminRoutes from './routes/admin.routes';
import { errorHandler } from './middlewares/errorHandler';

const app = express();

app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'wallet-service' }));

app.use('/api/wallets', walletRoutes);
app.use('/api/wallets/admin', adminRoutes);

// Hỗ trợ truy cập trực tiếp /reconciliation (W1-W4) tương thích cả 2 tiền tố
app.use('/reconciliation', (req, res, next) => {
  req.url = '/reconciliation' + (req.url === '/' ? '' : req.url);
  adminRoutes(req, res, next);
});

app.use(errorHandler);

export default app;
