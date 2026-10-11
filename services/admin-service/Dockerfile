FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /workspace/packages/finvault-internal-auth
COPY packages/finvault-internal-auth/ ./
RUN npm ci
WORKDIR /workspace/services/admin-service
COPY services/admin-service/package*.json ./
COPY services/admin-service/prisma ./prisma
RUN npm ci
COPY services/admin-service/src ./src
RUN npx prisma generate
EXPOSE 3007
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
