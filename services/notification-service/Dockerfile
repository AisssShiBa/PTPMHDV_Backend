FROM node:20-alpine
WORKDIR /app
COPY packages/finvault-internal-auth ./packages/finvault-internal-auth
WORKDIR /app/packages/finvault-internal-auth
RUN npm ci
COPY packages/finvault-events /app/packages/finvault-events
WORKDIR /app/packages/finvault-events
RUN npm ci && npm run build
WORKDIR /app/services/notification-service
COPY services/notification-service/package*.json ./
COPY services/notification-service/prisma ./prisma
RUN npm install
COPY services/notification-service/src ./src
COPY services/notification-service/tsconfig.json ./

EXPOSE 3006
CMD ["sh", "-c", "npx prisma generate && npx prisma migrate deploy && npm run start"]
