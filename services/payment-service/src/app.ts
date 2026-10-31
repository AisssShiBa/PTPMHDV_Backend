import './config/secrets';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import paymentRoutes from './routes/payment.routes';
import { errorHandler } from './middlewares/errorHandler';
import { requireInternalAuth } from './middlewares/internalAuth';
import { attachRequestId } from './middlewares/requestId';
import { validate } from './middlewares/validate';
import { paramIdSchema } from './validations/payment.validation';
import * as paymentController from './controllers/payment.controller';

const app = express();

app.use(helmet());
app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'payment-service' }));

// Route nội bộ theo đúng yêu cầu P0-2: /internal/payments/:id/confirm
app.post('/internal/payments/:id/confirm', requireInternalAuth, attachRequestId, validate(paramIdSchema), paymentController.internalConfirm);

app.use('/api/payments', paymentRoutes);

app.use(errorHandler);

export default app;
