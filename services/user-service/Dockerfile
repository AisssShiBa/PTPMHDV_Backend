FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /workspace/packages/finvault-internal-auth
COPY packages/finvault-internal-auth/ ./
RUN npm ci
WORKDIR /workspace/services/user-service
COPY services/user-service/package*.json ./
COPY services/user-service/prisma ./prisma
RUN npm ci
COPY services/user-service/tsconfig.json ./
COPY services/user-service/src ./src
RUN npx prisma generate && npm run build
EXPOSE 3002
CMD ["node", "dist/server.js"]
