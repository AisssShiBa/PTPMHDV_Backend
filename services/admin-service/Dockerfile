FROM node:20-alpine AS build
WORKDIR /app

# 1. Copy và cài dependencies cho package nội bộ finvault-internal-auth
COPY packages/finvault-internal-auth ./packages/finvault-internal-auth
WORKDIR /app/packages/finvault-internal-auth
RUN npm install --omit=dev

# 2. Copy dependencies và Prisma schema của admin-service
WORKDIR /app/services/admin-service
COPY services/admin-service/package*.json ./
COPY services/admin-service/prisma ./prisma
RUN npm install

# 3. Copy mã nguồn và generate Prisma client
COPY services/admin-service .
RUN npx prisma generate

EXPOSE 3007
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
