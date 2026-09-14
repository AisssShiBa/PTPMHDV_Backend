import 'dotenv/config';
import app from './app';
import { startHoldScheduler } from './wallet/wallet-hold.scheduler';

const port = process.env.PORT || 3004;

app.listen(port, () => {
  console.log(`Wallet Service is running on port ${port}`);
  startHoldScheduler();
});
