import type { Server } from 'socket.io'
import type { Server as HttpServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server as SocketIOServer } from 'socket.io'
import { verifyGatewayToken } from 'finvault-internal-auth'
import { env } from './config/env'

export let notificationIO: Server | null = null
const usedTickets = new Map<string, number>()
const issuedTickets = new Map<string, { jti: string; userId: string; expiresAt: number }>()
const ticketCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [jti, expiresAt] of usedTickets) {
    if (expiresAt <= now) usedTickets.delete(jti)
  }
  for (const [ticket, record] of issuedTickets) {
    if (record.expiresAt <= now) issuedTickets.delete(ticket)
  }
}, 60_000)
ticketCleanupInterval.unref()

export function issueSocketTicket(userId: string): { ticket: string; expiresAt: string } {
  if (!userId.trim()) throw new TypeError('Socket ticket userId must not be empty')
  const ticket = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + 60_000
  issuedTickets.set(ticket, { jti: randomUUID(), userId, expiresAt })
  return { ticket, expiresAt: new Date(expiresAt).toISOString() }
}

function consumeSocketTicket(ticket: string): { jti: string; userId: string } | undefined {
  const record = issuedTickets.get(ticket)
  issuedTickets.delete(ticket)
  if (!record || record.expiresAt <= Date.now()) return undefined
  return record
}

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
    const ticket = socket.handshake.auth?.ticket
    if (typeof ticket === 'string' && ticket.length > 0) {
      const auth = consumeSocketTicket(ticket)
      if (!auth) return next(new Error('INVALID_GATEWAY_TOKEN'))
      socket.data.userId = auth.userId
      return next()
    }

    // Deprecated compatibility path: accept a Gateway token only when no ticket is supplied.
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