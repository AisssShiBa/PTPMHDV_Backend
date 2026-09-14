FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm install --legacy-peer-deps
COPY . .
RUN npx prisma generate

EXPOSE 3005
CMD ["npm", "run", "start"]
