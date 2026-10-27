import { PrismaClient } from '@prisma/client'
import { env } from './env'

export const prisma = new PrismaClient({ datasourceUrl: env.databaseUrl })
