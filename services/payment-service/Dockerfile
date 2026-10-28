FROM node:20-alpine
WORKDIR /app

# Copy and install shared internal packages
COPY packages ./packages
RUN cd /app/packages/finvault-internal-auth && npm install && npm run build

# Copy service dependencies and config
WORKDIR /app/services/payment-service
COPY services/payment-service/package*.json ./
COPY services/payment-service/prisma ./prisma
COPY services/payment-service/tsconfig.json ./
RUN npm install

# Copy service source code only (avoids copying host node_modules)
COPY services/payment-service/src ./src
RUN ./node_modules/.bin/prisma generate

EXPOSE 3005
CMD ["sh", "-c", "./node_modules/.bin/prisma db push && npm run start"]
