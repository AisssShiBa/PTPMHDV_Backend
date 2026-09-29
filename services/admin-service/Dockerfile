FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm install
COPY . .
RUN npx prisma generate

EXPOSE 3007
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
