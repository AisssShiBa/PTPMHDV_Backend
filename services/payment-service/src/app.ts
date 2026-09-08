import express from 'express';
import paymentRoutes from './routes/payment.route';

const app = express();

app.use(express.json());

// Routes
app.use('/api/payments', paymentRoutes);

// Health check endpoint
app.get('/health', (req: express.Request, res: express.Response) => {
    res.status(200).json({ status: 'ok', service: 'payment-service' });
});

export default app;