import 'dotenv/config';
import app from './app';
import { startPaymentExpiryJob } from './jobs/payment-expiry.job';
import { startOutboxJob } from './jobs/outbox.job';
import { startTopupExpiryJob } from './jobs/expireTopups.job';
import { closeRabbitMQ } from './utils/rabbitmq.publisher';

const port = process.env.PORT || 3005;

const server = app.listen(port, () => {
  console.log(`Payment Service is running on port ${port}`);
  startPaymentExpiryJob();
  startOutboxJob();
  startTopupExpiryJob();
});

async function shutdown(signal: string) {
  console.log(`[Payment] Received ${signal}, shutting down gracefully...`);
  server.close();
  await closeRabbitMQ();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
