import 'dotenv/config';
import app from './app';
import { startOutboxScheduler } from './modules/payment/outbox.scheduler';

const port = process.env.PORT || 3005;

app.listen(port, () => {
  console.log(`Payment Service is running on port ${port}`);
  startOutboxScheduler();
});
