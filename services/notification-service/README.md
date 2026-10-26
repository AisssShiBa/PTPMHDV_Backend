# Notification service

## Internal event enrichment

`payment.succeeded` notifications use separate sender and receiver messages.
The notification service can look up a user's `fullName` through the existing
internal endpoint `GET /api/users/by-auth/:authUserId`, authenticated with the
shared `x-internal-key`. Configure `USER_LOOKUP_URL` to the base route, for
example `http://user-service:3002/api/users/by-auth`; the service appends the
encoded auth user ID. The lookup has a 1.5 second timeout, a 60 second
in-memory cache capped at 1,000 users, and degrades to "một người dùng" when
the URL is absent or a request fails. Only `fullName` is read from the
user-service response; names are never logged.

The shared `finvault-events` handler contract invokes a handler inside the
inbox transaction and has no pre-transaction enrichment hook. To avoid holding
a database transaction during network I/O, notification messages are first
committed with generic wording; the lookup then runs in the inbox adapter's
after-commit callback, updates the saved text when a name is available, and
emits that resulting notification to Socket.IO. If an update fails, the
already-committed generic notification is emitted. No lookup occurs for a
duplicate event. Adding a pre-`runOnce` hook would require changing the shared
package, which is outside this phase's allowed scope.

### Configuration handoff

- **Đạt / deployment:** wire optional `USER_LOOKUP_URL` to the user-service
  internal route base above. No compose file was changed in this phase.
- **Hữu / user-service:** the existing `GET /api/users/by-auth/:authUserId`
  route accepts the shared internal key and returns `fullName`. No new route
  change is needed; confirm it remains available for service-to-service calls.
- **Khoa / payment-service:** if transfer notes should be included, add a
  reviewed `note` field to the event contract in a later coordinated change;
  this phase intentionally does not add it.

## Handoff N8: payment Outbox

Payment and wallet producer code remains owned by Khoa and was not changed.

1. Trigger an Outbox drain immediately after the business transaction commits;
   keep the existing 5-second cron as a safety net (or lower it to 1 second).
2. Set `publishedAt` only after `finvault-events` `publish()` resolves.
3. Publish a complete `payment.succeeded` event envelope to `finvault.events`
   when cutting over from the legacy exchange.
4. Do not disable legacy exchanges this week. Dual-publishing the same business
   payment to both legacy and FinVault consumers can create two notifications.
   Cut over by enabling the new publisher and disabling the old publisher in
   the same release, or coordinate business idempotency on
   `(paymentId, recipientId, category)`.

## Socket ticket checks

- S14 backend one-time ticket behavior is covered by
  `tests/socket.test.ts` ("a Gateway Token jti can be used only once").
- Frontend reconnect auth freshness is covered by
  `PTPMHDV_Frontend/tests/notification.test.ts`
  ("socket auth obtains a fresh ticket every time Socket.IO requests auth").
- Socket.IO handshake contract remains `auth: { token: ticket }`.

## R1 latency and S16 reconnect

Run the isolated PostgreSQL and RabbitMQ stack, apply migrations to its test
database, and start the notification service with those test URLs. Keep the
service running while measuring or restarting RabbitMQ:

```powershell
docker compose -f docker-compose.test.yml up -d --wait
$env:DATABASE_URL = "postgresql://notification_test:notification_test@localhost:5434/notification_service_test"
$env:RABBITMQ_URL = "amqp://finvault_test:finvault_test@localhost:5674"
npx prisma migrate deploy
npm start
```

In another terminal, using the same test URLs:

```powershell
npm run measure:latency
npm run test:s16
docker compose -f docker-compose.test.yml down
```

R1 prints ten samples and passes only if at least 9/10 are no more than 3
seconds. The interval is from the publisher confirm resolving to the matching
Socket.IO `notification:new` event; it does not include producer Outbox wait.
For local development, the measurement obtains a test Gateway token and
requests the socket ticket endpoint; production requires
`NOTIFICATION_GATEWAY_TOKEN`.

S16 restarts only the isolated RabbitMQ test container while a finance consumer
is running, waits for its consumer registration to return, then publishes an
event and a duplicate and verifies one inbox row and one notification. It is
destructive to in-flight state in the test broker; do not aim it at a shared or
production broker.

### Latest local run

Environment: Windows, local notification service on port 3006, isolated
PostgreSQL test DB on port 5434, and the dedicated RabbitMQ test container on
port 5674. `USER_LOOKUP_URL` was unset, so the run exercised generic wording.

R1 (`npm run measure:latency`) actual samples:

```text
R1 1/10: 39.1 ms
R1 2/10: 7.6 ms
R1 3/10: 7.5 ms
R1 4/10: 11.4 ms
R1 5/10: 10.0 ms
R1 6/10: 5.4 ms
R1 7/10: 5.9 ms
R1 8/10: 9.2 ms
R1 9/10: 5.9 ms
R1 10/10: 5.4 ms
R1 result: 10/10 samples <= 3000 ms
R1 conclusion: PASS (at least 9/10 <= 3000 ms)
```

S16 (`npm run test:s16`) restarted the RabbitMQ test container with consumers
running, observed consumer reconnect, then confirmed one stored notification
and one inbox record after publishing the same event twice:

```text
RabbitMQ test container restarted while the finance consumer was running
Finance consumer reconnected and restored its queue consumer
S16 PASS: notification arrived once after RabbitMQ recovery; duplicate publish remained idempotent
```

The R1 values measure only publisher-confirm to socket receipt; they do not
include producer Outbox wait or user-service name lookup (disabled in this run).
