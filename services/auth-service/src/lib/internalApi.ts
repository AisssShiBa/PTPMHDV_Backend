import axios from 'axios'

// Instance Axios dành riêng cho việc giao tiếp giữa các Microservices
const internalApiKey = process.env.INTERNAL_API_KEY
if (!internalApiKey) {
  throw new Error('Thiếu biến môi trường bắt buộc: INTERNAL_API_KEY')
}
export const internalApi = axios.create({
  headers: { 'X-Internal-Key': internalApiKey },
  timeout: 2000
})
