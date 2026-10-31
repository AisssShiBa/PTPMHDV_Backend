FROM node:20-alpine
WORKDIR /app

# Copy and build shared packages used by this service
COPY packages/finvault-internal-auth ./packages/finvault-internal-auth
COPY packages/finvault-events ./packages/finvault-events
RUN cd /app/packages/finvault-internal-auth && npm ci && npm run build
RUN cd /app/packages/finvault-events && npm ci && npm run build

# Copy service dependencies and config
WORKDIR /app/services/wallet-service
COPY services/wallet-service/package*.json ./
COPY services/wallet-service/prisma ./prisma
COPY services/wallet-service/tsconfig.json ./
RUN npm ci

# Copy service source code only (avoids copying host node_modules)
COPY services/wallet-service/src ./src
RUN ./node_modules/.bin/prisma generate && npm run build

EXPOSE 3004
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && npm run start"]
