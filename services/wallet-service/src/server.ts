import 'dotenv/config';
import app from './app';
import { startHoldScheduler } from './jobs/wallet-hold.scheduler';
import { startOutboxScheduler } from './jobs/outbox.scheduler';

const port = process.env.PORT || 3004;

app.listen(port, () => {
  console.log(`Wallet Service is running on port ${port}`);
  startHoldScheduler();
  startOutboxScheduler();
});
