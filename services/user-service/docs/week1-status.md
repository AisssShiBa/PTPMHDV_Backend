# Week 1 implementation status

Updated 2026-10-11. User/Merchant auth is now integrated. Necessary Gateway, Auth ingress, Admin authentication and Docker changes were also made; pre-existing business changes were preserved. See [completion evidence](../../../docs/User_Merchant_Completion_Report.md) and [runtime instructions](../../../docs/User_Merchant_Runtime.md).

## Implemented

- H2: retained registration consumer/ConsumedEvent/retry/DLQ. Added real-DB tests for Inbox failure rollback and an event arriving after HTTP provisioning.
- H3: `kycTier` defaults to 0 for new and existing profiles, including APPROVED profiles. Tier remains independent of KYC status, as confirmed by the user. Added a User Outbox and `updateKycTier(profileId, nextTier)` trusted domain operation. Tier is not writable through public profile/upload routes. No new public/admin tier endpoint or User publisher is included.
- H4: private-prefix orphan scanner with configurable positive grace period and a read-only dry-run. Preserved queued cleanup and durable upload intent. Final upload commits and deletes share a PostgreSQL advisory lock per object key; a removed intent prevents a late upload commit from creating a dangling reference.
- H6: `GET /api/users/me`, `GET /api/users/me/kyc`, `POST /api/users/me/kyc`; current-user lookup uses the signed Auth ID. Existing by-auth/ID routes remain available. OpenAPI: `docs/openapi.json` in each service.
- H5 profile portion: Merchant updates and `merchant.profile_updated` use the existing transaction/enqueue/publisher. Unchanged values are no-ops; no financial account/tax fields enter events.

## Auth and runtime completed

- H1/H5 auth uses `finvault-internal-auth` and `req.auth`. Missing/invalid Gateway Token returns 401 with `requestId`; owner/admin checks remain active. Public health endpoints remain available.
- Gateway strips client-supplied internal credentials. Auth provisioning/Admin review retain verified internal-key calls; Admin ingress now verifies the shared token and public Auth endpoints no longer require the old marker.
- Package outputs JavaScript/declarations. Production keys are required, dev keys rejected, claims/issuer/audience/ES256/TTL validated. Both compiled service images passed a real Docker smoke test.
- Main compose includes migration jobs, event workers, a demo Merchant event queue, private storage with prefix-scoped service credentials and a browser-reachable signing endpoint.
- Real-browser acceptance passed 17 checks. Full frontend typecheck/build still fails on three unused declarations in AdminTopups.tsx; the tested source bundle was built with Vite. Frontend source was not edited.

## Remaining handoff / outside scope

- The team still needs to review the event contract (`eventVersion`, `data.authUserId`, local profile `aggregateId`) and frontend OpenAPI handoff. Technical tests are not a claim of teammate approval.
- Khoa PR review and actual production deployment remain manual follow-up. Credentials and persistent volumes of existing deployments must be checked before applying the new compose configuration.
- User Outbox remains atomic persistence only; no User publisher, Admin tier UI/API or tier-to-access-token synchronization is included.

## Operation and verification

Verified in this workspace on 2026-10-11: 27 unit/API/contract tests and 26 integration tests passed; TypeScript typecheck/build passed. The integration suite includes applying the new migration to isolated old-row fixtures, preserving APPROVED status with tier 0, actual Outbox/Inbox rollback, consumer retry/restart, KYC scan, upload/delete races and a storage-delete/DB-rollback failure. Migrations were verified only in isolated integration, acceptance and runtime-test databases.

From `services/user-service`:

```powershell
rtk npx prisma generate
rtk npm run test:db
rtk npm test
rtk npm run test:integration
rtk npm run typecheck
rtk npm run build
```

The test migration script targets `finvault_test?schema=user_test`; Merchant uses the same DB with `merchant_test`. Do not change these to application databases. Integration tests reset service-specific test data. Migrations were also verified in isolated acceptance/runtime environments; existing application databases were not migrated by this task.

User `npm test` includes OpenAPI validation for both service contracts. Unit/API tests validate identity, privacy and rejection of direct tier/status assignment. Integration tests exercise actual PostgreSQL transactions, RabbitMQ confirms/retry/restart and private MinIO uploads/deletion.

Apply application migrations using the normal reviewed deployment procedure, then regenerate/build the client. Without the tier migration the new User client cannot query profiles correctly.

## KYC cleanup

`KYC_CLEANUP_GRACE_MS` defaults to 86400000 (24 hours), must be positive, and configures new upload intents plus scanner object-age protection. Existing queued jobs retain their persisted schedule. `STORAGE_CLEANUP_ENABLED=false` disables the HTTP server's queued-cleanup timer; default remains true.

```powershell
# Default is dry-run; no object or cleanup-table mutation.
rtk npm run storage:cleanup
rtk npm run storage:cleanup -- --dry-run

# Explicitly delete eligible orphans.
rtk npm run storage:cleanup -- --delete
```

Dry-run lists candidate object keys and a summary. Stop other deleting cleanup processes or start HTTP servers with `STORAGE_CLEANUP_ENABLED=false` during a dry-run demonstration. Run scanner CLI as a separate maintenance invocation; no additional periodic scan scheduler is started automatically.

Storage access needs ListBucket scoped to prefix `kyc/` plus existing Get/Put/DeleteObject access. Scanner skips other prefixes, unknown age, young objects and protected intents; DB lookup failures fail closed. References from soft-deleted profiles are still protected. Failed deletes remain discoverable for a later scan; queued cleanup retains its retry behavior. Keep KYC keys immutable and generated by the service. Upload commit verifies object existence under the per-key lock, covering a successful storage delete whose subsequent DB transaction rolled back.

## Contract usage

Import `docs/openapi.json` into the frontend mock/documentation tool. The server URL is the Gateway `/api` base. Clients send a Bearer access token; they must not supply internal authentication headers. Response examples are included in the OpenAPI files.

`GET /users/me/kyc` returns only `kycStatus`, `kycTier`, `hasKycDocument`. `POST /users/me/kyc` takes `idNumber` plus one `document` JPEG/PNG up to 5 MiB and returns the profile envelope. An authorized document URL is available through the existing by-auth document route and expires after 60 seconds. Missing User profiles return 404; missing Merchant profiles return `data: null` from `/merchants/me`.
