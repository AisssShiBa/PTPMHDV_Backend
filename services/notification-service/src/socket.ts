import type { Server } from 'socket.io'
import type { Server as HttpServer } from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import { verifyGatewayToken } from 'finvault-internal-auth'
import { env } from './config/env'

export let notificationIO: Server | null = null
const usedTickets = new Map<string, number>()
const ticketCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [jti, expiresAt] of usedTickets) {
    if (expiresAt <= now) usedTickets.delete(jti)
  }
}, 60_000)
ticketCleanupInterval.unref()

export const setNotificationIO = (io: Server) => {
  notificationIO = io
}

export const createSocketServer = (
  httpServer: HttpServer,
  options: { maxAgeMs?: number } = {}
) => {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.clientUrl,
      credentials: true
    }
  })
  const maxAgeMs = options.maxAgeMs ?? env.socketMaxAgeMs

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string' || token.length === 0) {
      return next(new Error('INVALID_GATEWAY_TOKEN'))
    }

    try {
      const auth = verifyGatewayToken(token)
      if (!auth.jti || usedTickets.has(auth.jti)) {
        return next(new Error('INVALID_GATEWAY_TOKEN'))
      }

      // Ticket chỉ chứng minh danh tính user này trong tối đa 60 giây; không ghi giá trị ticket vào log.
      // Map trong bộ nhớ chỉ chống dùng lại trên một instance; nhiều instance cần Redis.
      usedTickets.set(auth.jti, Date.now() + 60_000)
      socket.data.userId = auth.userId
      return next()
    } catch {
      return next(new Error('INVALID_GATEWAY_TOKEN'))
    }
  })

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`)
    const disconnectTimer = setTimeout(() => socket.disconnect(true), maxAgeMs)
    socket.once('disconnect', () => clearTimeout(disconnectTimer))
  })

  setNotificationIO(io)
  return io
}