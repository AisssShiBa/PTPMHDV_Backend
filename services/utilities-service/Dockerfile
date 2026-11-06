FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY packages/finvault-internal-auth ./packages/finvault-internal-auth
WORKDIR /app/packages/finvault-internal-auth
RUN npm ci
COPY packages/finvault-events /app/packages/finvault-events
WORKDIR /app/packages/finvault-events
RUN npm ci && npm run build
WORKDIR /app/services/utilities-service
COPY services/utilities-service/package*.json ./
COPY services/utilities-service/prisma ./prisma
RUN npm install
COPY services/utilities-service/tsconfig.json ./
COPY services/utilities-service/src ./src
RUN npx prisma generate && npm run build
EXPOSE 3008
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
