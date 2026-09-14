import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import walletRoutes from './routes/wallet.routes';
import adminRoutes from './routes/admin.routes';
import { errorHandler } from './middlewares/errorHandler';

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.use('/api/wallets', walletRoutes);
app.use('/api/admin', adminRoutes);

app.use(errorHandler);

export default app;
