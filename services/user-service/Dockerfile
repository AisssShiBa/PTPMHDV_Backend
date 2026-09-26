FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
EXPOSE 3002
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
