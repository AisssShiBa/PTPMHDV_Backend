import 'dotenv/config'
import { loadSecretEnvironment } from 'finvault-internal-auth'
loadSecretEnvironment(['INTERNAL_KEY'])

export const internalKey = process.env.INTERNAL_KEY?.trim()
if (!internalKey) throw new Error('Missing required environment variable: INTERNAL_KEY')
