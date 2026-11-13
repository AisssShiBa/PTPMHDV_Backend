import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const defaultPassword = process.env.POSTGRES_PASSWORD || '404897ba313a20d9a166a1db0625276a77186fc0160c690a5e6e93ee09e06720';
const paymentDbUrl = process.env.PAYMENT_DATABASE_URL ||
  (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('payment_service')
    ? process.env.DATABASE_URL
    : `postgresql://postgres:${defaultPassword}@localhost:5432/payment_service?schema=public`);

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: paymentDbUrl,
    },
  },
});
