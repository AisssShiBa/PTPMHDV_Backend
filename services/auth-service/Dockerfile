FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /workspace/packages/finvault-internal-auth
COPY packages/finvault-internal-auth/ ./
RUN npm ci
WORKDIR /workspace/services/auth-service
COPY services/auth-service/package*.json ./
COPY services/auth-service/prisma ./prisma
RUN npm ci
COPY services/auth-service/src ./src
COPY services/auth-service/tsconfig.json ./
RUN npx prisma generate

EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
