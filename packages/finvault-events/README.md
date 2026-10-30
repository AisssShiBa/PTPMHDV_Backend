# finvault-events

Shared FinVault event envelope, schemas, confirmed RabbitMQ publisher, retrying consumer, and inbox contract.

## Install and build

Use a local file dependency from a service, e.g. `"finvault-events": "file:../../packages/finvault-events"`. The Docker build context must be the repository root and include both `packages/finvault-events` and the service directory. The package follows the repository CommonJS/ES2022 `dist` convention.

```sh
npm ci
npm run build
npm test
```

Unit tests use `node:test` through `tsx --test`. RabbitMQ integration tests are separate and only run when `RABBITMQ_URL` is set:

```sh
docker compose -f packages/finvault-events/docker-compose.test.yml up -d --wait
RABBITMQ_URL=amqp://finvault_test:finvault_test@localhost:5673 RABBITMQ_TEST_CONTAINER=finvault-events-rabbitmq-test npm run test:integration
docker compose -f packages/finvault-events/docker-compose.test.yml down
```

On PowerShell, set the two environment variables before running `npm.cmd run test:integration`.

## Publishing

```ts
import { createPublisher, type FinvaultEvent } from 'finvault-events'

const publisher = createPublisher({ url: process.env.RABBITMQ_URL! })
const event: FinvaultEvent<{ authUserId: string; kycTier: number; previousTier: number }> = {
  eventId: crypto.randomUUID(),
  eventType: 'user.kyc_updated',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  data: { authUserId: 'auth-user-id', kycTier: 2, previousTier: 1 }
}
await publisher.publish(event)
await publisher.close()
```

Publishing validates envelope and payload, then waits for a publisher confirm. The message is persistent, has `messageId = eventId`, `type = eventType`, `contentType = application/json`, and `x-event-version`; the routing key is exactly `eventType`. Unroutable messages, broker nacks, timeouts, and channel/connection loss reject. A confirm means the broker accepted the message, **not** that a consumer processed it. A durable Outbox should only mark an event sent once `publish()` resolves and should drain after the business transaction commits.

For Prisma-backed outboxes, `createEventFromOutbox` validates and builds the
standard envelope from a persisted row. The row ID becomes `eventId` and
`createdAt` becomes the UTC `occurredAt`; map service-specific columns into
`data` before calling it:

```ts
const event = createEventFromOutbox(
  { id: row.id, createdAt: row.createdAt },
  'payment.succeeded',
  {
    paymentId: row.aggregateId,
    senderId: payload.userId,
    receiverId: payload.destinationUserId,
    amount: String(payload.amount)
  }
)
await publisher.publish(event)
```

Outbox IDs must be UUIDs because `eventId` is a UUID in the envelope contract.
The helper validates the event type, version and mapped payload before returning.

## Consuming, inbox and transactions

```ts
import { createConsumer, createInMemoryInbox } from 'finvault-events'

const consumer = createConsumer({
  url: process.env.RABBITMQ_URL!,
  queue: 'notification.finvault.events',
  bindings: ['user.#', 'payment.#'],
  prefetch: 10,
  maxRetries: 3,
  retryDelaysMs: [1000, 5000, 30000],
  inbox: serviceInboxAdapter,
  handlers: {
    'user.kyc_updated': async (event, { tx }) => {
      // Apply service-specific database changes using tx.
    }
  }
})
await consumer.start()
// On shutdown:
await consumer.stop()
```

The service owns its database-specific `InboxAdapter`; its `runOnce` must insert the inbox key and run the handler in the **same database transaction**. The in-memory adapter is for examples/tests only. A Prisma adapter can follow `ingestNotification` in notification-service and use parameterized SQL:

```ts
const inboxAdapter = {
  runOnce: (args, fn) => prisma.$transaction(async tx => {
    const inserted = await tx.$executeRaw`
      INSERT INTO "EventInbox" ("eventId", "eventType", "payloadHash")
      VALUES (${args.eventId}, ${args.eventType}, ${args.payloadHash})
      ON CONFLICT ("eventId") DO NOTHING
    `
    if (inserted === 0) {
      const rows = await tx.$queryRaw<Array<{ payloadHash: string }>>`
        SELECT "payloadHash" FROM "EventInbox" WHERE "eventId" = ${args.eventId}
      `
      if (!rows[0]) throw new Error('Inbox row missing after conflict')
      return rows[0].payloadHash === args.payloadHash
        ? { status: 'duplicate' as const }
        : { status: 'conflict' as const }
    }
    return { status: 'processed' as const, result: await fn(tx) }
  })
}
```

The service must provision the inbox table and unique `eventId` constraint; N11 requires no migration. Payload hashes are SHA-256 of canonical JSON for `{eventType, eventVersion, data}` (sorted object keys, excluding `occurredAt`). Duplicate IDs are acked without another handler call. A changed payload under an existing ID is dead-lettered as `EVENT_CONFLICT`.

## Event catalog and versioning

The envelope is strict; payload schemas validate their known fields and preserve additive fields so newer producers can add a field without breaking older consumers. Additive fields keep the version; changing/removing fields requires a new version. Consumers should support old and new versions during the one-week migration window. Unknown types/versions are dead-lettered immediately.

| Event type | Version 1 data |
| --- | --- |
| `user.registered` | `{ authUserId, email, phone? }` |
| `user.kyc_updated` | `{ authUserId, kycTier, previousTier }` |
| `merchant.status_updated` | `{ merchantId, status }` |
| `payment.succeeded` | `{ paymentId, senderId, receiverId, amount }` |
| `payment.failed` | `{ paymentId, senderId, reason }` |
| `payment.expired` | `{ paymentId, senderId }` |
| `wallet.limit_exceeded` | `{ userId, limitType, kycTier }` |

`amount` is a non-negative decimal integer string (never a JS `number`); `addAmounts` and `compareAmounts` use `BigInt`.

KYC v1 requires `previousTier`. Old outbox records without that value are accepted only when `allowLegacyKycUpdated: true`; handlers receive `{ authUserId, kycTier, previousTier: undefined, legacy: true }`. No value is guessed. Existing records do not currently distinguish old from new payloads by event version, so the producer must establish an explicit versioning strategy. **Hữu must update H7 to publish `{authUserId, kycTier, previousTier}`.** Do not silently treat a legacy record as a complete v1 payload.

## Topology and retry/DLQ

Every publisher and consumer idempotently asserts the shared `finvault.events` topic exchange as durable, using exactly those parameters. Each consumer owns and asserts its own durable main queue, one retry queue per distinct delay (`<queue>.retry.<delayMs>`), and `<queue>.dlq`; it binds the main queue to its configured patterns. Each retry queue has a queue-level TTL and dead-letters to the main queue, so a long-delay retry cannot block a shorter retry. `broker-init` remains merchant-service-owned and is not the owner of other services' queues. In development environments previously run with N11, the obsolete `<queue>.retry` queue can be manually deleted if it is empty; the library does not assert or reuse it.

Handler failures are republished to the retry queue corresponding to the selected backoff delay with `x-retry-count`; TTL is configured on the queue, not each message. The configured delay list bounds retry attempts. The original delivery is acked only after a retry or DLQ publish is confirmed. Exhausted/permanent failures go to `<queue>.dlq` with `x-dlq-reason`, `x-original-routing-key`, `x-retry-count`, and `x-failed-at`; stack traces and payload data are not copied to headers. `NonRetryableError` skips retries. The consumer reconnects after broker connection loss and `stop()` cancels consumption and waits for work to settle.

Consumers that bind broad routing patterns may list valid event types they intentionally do not handle, for example notification can use `ignoredEventTypes: ['user.registered']`. Such events are logged at info using only their ID and type, then acked without calling a handler or inbox. An event type not registered in this package is still dead-lettered as `UNKNOWN_EVENT_TYPE`, even if listed as ignored; parse/registry validation happens first. An unregistered or unsupported event type/version must be added to the registry before a consumer can intentionally ignore it.

## Handoff

- **Hữu (H7):** publish the complete KYC v1 data above with `user.kyc_updated` as routing key, through `createPublisher` or equivalent confirmed publishing. Legacy Outbox rows lack `previousTier`; use the explicit legacy mode, and do not guess. No `broker-init` change is needed.
- **Đạt (Đ12):** use `createConsumer` and a Wallet Prisma inbox adapter; the Wallet consumer owns `wallet.finvault.events`. Auth currently builds from `services/auth-service`, so its Docker build context must move to the repository root before importing this package; Đạt owns that change.
- **Khoa:** publish a complete envelope and mark Outbox entries sent only after `publish()` resolves; drain after commit. Wallet's existing `{userId,type,message}` Outbox is not this envelope and needs a migration path before routing to `finvault.events`. Keep the legacy delivery active until N8 handles duplicate-notification risk.
- **Nguyên (next day):** N8 should adopt this consumer for notification mapping and multi-recipient transactional inbox handling.

## Example and current limits

Run `npx tsx examples/demo.ts`. With `RABBITMQ_URL` it uses a real broker; without it the output explicitly identifies a fake-channel demonstration. The package provides reusable envelope construction and single-flight drain helpers, but services still own their database-specific transactional Outbox and Inbox implementations. Publisher confirms do not guarantee consumer processing, and in-memory inbox storage is never suitable for production.
