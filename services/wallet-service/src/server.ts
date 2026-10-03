import 'dotenv/config';
import app from './app';
import { startHoldScheduler } from './jobs/wallet-hold.scheduler';
import { startOutboxScheduler } from './jobs/outbox.scheduler';
import { closeRabbitMQ } from './utils/rabbitmq.publisher';

const port = process.env.PORT || 3004;

const server = app.listen(port, () => {
  console.log(`Wallet Service is running on port ${port}`);
  startHoldScheduler();
  startOutboxScheduler();
});

async function shutdown(signal: string) {
  console.log(`[Wallet] Received ${signal}, shutting down gracefully...`);
  server.close();
  await closeRabbitMQ();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
