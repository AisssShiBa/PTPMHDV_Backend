import axios from 'axios'

import { env } from '../config/env'

// Instance Axios dành riêng cho việc giao tiếp giữa các Microservices
const internalApiKey = env.internalApiKey || process.env.INTERNAL_KEY || process.env.INTERNAL_API_KEY
if (!internalApiKey) {
  throw new Error('Thiếu biến môi trường bắt buộc: INTERNAL_KEY')
}
export const internalApi = axios.create({
  headers: { 'X-Internal-Key': internalApiKey },
  timeout: 2000
})
