FROM node:20-alpine
WORKDIR /app

# Copy and install shared internal packages
COPY packages ./packages
RUN cd /app/packages/finvault-internal-auth && npm install && npm run build

# Copy service dependencies and config
WORKDIR /app/services/wallet-service
COPY services/wallet-service/package*.json ./
COPY services/wallet-service/prisma ./prisma
COPY services/wallet-service/tsconfig.json ./
RUN npm install

# Copy service source code only (avoids copying host node_modules)
COPY services/wallet-service/src ./src
RUN ./node_modules/.bin/prisma generate

EXPOSE 3004
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && npm run start"]
