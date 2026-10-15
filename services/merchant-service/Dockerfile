FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /workspace/packages/finvault-internal-auth
COPY packages/finvault-internal-auth/ ./
RUN npm ci
WORKDIR /workspace/services/merchant-service
COPY services/merchant-service/package*.json ./
COPY services/merchant-service/prisma ./prisma
RUN npm ci
COPY services/merchant-service/tsconfig.json ./
COPY services/merchant-service/src ./src
COPY services/merchant-service/scripts ./scripts
RUN npx prisma generate && npm run build
EXPOSE 3003
CMD ["node", "dist/server.js"]
