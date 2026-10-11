import { io } from 'socket.io-client'
import { createTestGatewayToken } from 'finvault-internal-auth'

const url = process.argv[2]
if (!url) {
  throw new Error('Cần truyền URL notification-service, ví dụ: npm run socket:smoke -- http://localhost:3006')
}

const userId = process.env.TEST_USER_ID || 'notification-socket-smoke-user'
const token = createTestGatewayToken(userId)
const socket = io(url, {
  auth: { token },
  transports: ['websocket', 'polling']
})

socket.on('connect', () => console.log('connected'))
socket.on('notification:new', (notification: unknown) => {
  console.log('notification:new', notification)
})
socket.on('connect_error', (error) => {
  console.error('Socket connection failed:', error.message)
  process.exitCode = 1
})

process.once('SIGINT', () => {
  socket.disconnect()
  process.exit()
})
