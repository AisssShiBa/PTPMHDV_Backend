# Notification service tests

Database-backed tests create and delete records. Never point `DATABASE_URL` at
a production or shared development database. The isolated test stack uses
PostgreSQL and RabbitMQ on ports 5434 and 5674:

```powershell
Set-Location services/notification-service
docker compose -f docker-compose.test.yml up -d --wait
$env:DATABASE_URL = "postgresql://notification_test:notification_test@localhost:5434/notification_service_test"
$env:RABBITMQ_URL = "amqp://finvault_test:finvault_test@localhost:5674"
npx prisma migrate deploy
npm test
npm run test:integration
docker compose -f docker-compose.test.yml down
```

`npm test` runs auth, notification routes, sockets, inbox, and finance-event
mapping tests. The RabbitMQ/PostgreSQL integration test runs only when
`DATABASE_URL` points to a local database whose name ends in `_test` and
`RABBITMQ_URL` points to local RabbitMQ. It verifies transactional inbox
behavior, duplicate delivery, conflict dead-lettering, ignored events, legacy
KYC mapping, and Socket.IO emission. Existing tests continue to cover the
legacy notification consumer.

The separate integration command is useful when diagnosing broker behavior:

```powershell
npm run test:integration
```
