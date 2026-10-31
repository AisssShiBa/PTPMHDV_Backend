import { transactionPublicKey } from './utils/transaction-token';
import 'dotenv/config';
import app from './app';
import { startPaymentExpiryJob } from './jobs/payment-expiry.job';
import { startOutboxJob } from './jobs/outbox.job';
import { startTopupExpiryJob } from './jobs/expireTopups.job';
import { startTokenCleanupJob } from './jobs/cleanup-tokens.job';
import { closeRabbitMQ } from './utils/rabbitmq.publisher';
import { closeFinvaultOutboxPublisher } from './jobs/outbox.job';

transactionPublicKey();
const port = process.env.PORT || 3005;

const server = app.listen(port, () => {
  console.log(`Payment Service is running on port ${port}`);
  startPaymentExpiryJob();
  startOutboxJob();
  startTopupExpiryJob();
  startTokenCleanupJob();
});

async function shutdown(signal: string) {
  console.log(`[Payment] Received ${signal}, shutting down gracefully...`);
  server.close();
  await closeFinvaultOutboxPublisher();
  await closeRabbitMQ();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
