# Notification service tests

The test suite uses a real PostgreSQL database through `DATABASE_URL`.
Use a dedicated test database: route and inbox tests create database records.
Those tests clean up the records they create; do not point them at production data.

From the repository root, configure a local test database, apply migrations,
then run the service tests:

```powershell
$env:DATABASE_URL = "postgresql://postgres:password@localhost:5432/notification_service_test"
Set-Location services/notification-service
npx prisma migrate deploy
npm test
```

The database must be running and reachable before applying migrations or testing.
`npm test` runs auth, notification route, socket, and inbox tests.
The current tests do not connect to RabbitMQ; the consumer broker is not required.
If later broker integration tests are added, start RabbitMQ and configure
`RABBITMQ_URL` before running `npm test`.
