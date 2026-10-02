import 'dotenv/config';
import app from './app';
import { startPaymentExpiryJob } from './jobs/payment-expiry.job';
import { startOutboxJob } from './jobs/outbox.job';
import { startTopupExpiryJob } from './jobs/expireTopups.job';

const port = process.env.PORT || 3005;

app.listen(port, () => {
  console.log(`Payment Service is running on port ${port}`);
  startPaymentExpiryJob();
  startOutboxJob();
  startTopupExpiryJob();
});
