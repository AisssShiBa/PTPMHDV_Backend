FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npm run prisma:generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npm run prisma:generate
COPY --from=build /app/dist ./dist

EXPOSE 4004
CMD ["sh", "-c", "npm run prisma:migrate:deploy && npm run start:prod"]
