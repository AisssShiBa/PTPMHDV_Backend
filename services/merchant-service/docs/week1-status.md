# Week 1 Merchant changes

Updated 2026-10-11. Merchant auth and Docker runtime are integrated; pre-existing `/me` and profile Outbox changes are preserved. See [completion evidence](../../../docs/User_Merchant_Completion_Report.md).

`PUT /api/merchants/:id` now calls `updateProfile` in the service layer. A serializable transaction updates editable fields, increments the aggregate version and enqueues `merchant.profile_updated`. Identical values return the existing record without increasing version or producing an event. Insert failure rolls back the profile/version. Concurrent profile and status updates use the existing serialization retry behavior.

Existing `merchant.registered`/`merchant.status_updated` events and the publisher retain aggregate ordering, PROCESSING leases, confirm/retry/FAILED/replay behavior. Profile events reuse the envelope and data fields already emitted by the enqueue helper; bank account and tax ID stay out of the event.

OpenAPI is in `docs/openapi.json`, covering registration, current merchant, profile update and admin listing. `/me` returns `data: null` for no active registration and preserves database failures as errors. Frontend uses Bearer auth through the Gateway. `finvault-internal-auth` verifies Gateway Token and supplies `req.auth`; legacy marker/access JWT verification is removed. Auth/Admin internal calls still require a valid internal key.

## Verification

Verified in this workspace on 2026-10-11: 17 unit/API tests and 12 integration tests passed; TypeScript typecheck/build passed. This includes profile Outbox rollback/no-op, concurrent profile/status ordering and the existing publisher regression suite. Merchant test migrations were applied only to the isolated test schema.

From this service directory:

```powershell
rtk npm test
rtk npm run test:db
rtk npm run test:integration
rtk npm run typecheck
rtk npm run build
```

Test migrations/data use only `finvault_test?schema=merchant_test`. Integration tests reset Merchant test data and use the RabbitMQ test exchange. User service's `npm test` validates both OpenAPI documents. No new Merchant DB migration is required for the profile event.

Run the existing publisher separately with `npm run worker` or `node dist/events/worker.js`. Bind the receiving queue to `merchant.profile_updated` (or the agreed wildcard), alongside existing routing keys. Main compose now runs migration and publisher separately. Production-image smoke published all three event types; full Gateway/Auth/Admin/browser acceptance passed 17 checks. Team handoff/review is still pending, and full frontend build has pre-existing TS6133 errors documented in the completion report.
