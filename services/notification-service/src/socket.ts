import type { Server } from 'socket.io'
import type { Server as HttpServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server as SocketIOServer } from 'socket.io'
import { verifyGatewayToken } from 'finvault-internal-auth'
import { env } from './config/env'

export let notificationIO: Server | null = null
const usedTickets = new Map<string, number>()
const issuedTickets = new Map<string, { jti: string; userId: string; expiresAt: number }>()
const ticketRequests = new Map<string, number[]>()
const SOCKET_TICKETS_PER_MINUTE = 10
const MAX_UNUSED_TICKETS_PER_USER = 5
const SOCKET_TICKET_LIFETIME_MS = 60_000

export class SocketTicketRateLimitError extends Error {
  constructor() {
    super('Socket ticket request limit exceeded')
    this.name = 'SocketTicketRateLimitError'
  }
}

const ticketCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [jti, expiresAt] of usedTickets) {
    if (expiresAt <= now) usedTickets.delete(jti)
  }
  for (const [ticket, record] of issuedTickets) {
    if (record.expiresAt <= now) issuedTickets.delete(ticket)
  }
  for (const [userId, timestamps] of ticketRequests) {
    const active = timestamps.filter(timestamp => now - timestamp < SOCKET_TICKET_LIFETIME_MS)
    if (active.length > 0) ticketRequests.set(userId, active)
    else ticketRequests.delete(userId)
  }
}, 60_000)
ticketCleanupInterval.unref()

export function issueSocketTicket(userId: string): { ticket: string; expiresAt: string } {
  if (!userId.trim()) throw new TypeError('Socket ticket userId must not be empty')
  const now = Date.now()
  const requests = (ticketRequests.get(userId) ?? [])
    .filter(timestamp => now - timestamp < SOCKET_TICKET_LIFETIME_MS)
  if (requests.length >= SOCKET_TICKETS_PER_MINUTE) {
    ticketRequests.set(userId, requests)
    throw new SocketTicketRateLimitError()
  }
  requests.push(now)
  ticketRequests.set(userId, requests)

  for (const [oldTicket, record] of issuedTickets) {
    if (record.userId === userId && record.expiresAt <= now) issuedTickets.delete(oldTicket)
  }
  let outstanding = [...issuedTickets].filter(([, record]) => record.userId === userId)
  while (outstanding.length >= MAX_UNUSED_TICKETS_PER_USER) {
    issuedTickets.delete(outstanding[0][0])
    outstanding = outstanding.slice(1)
  }

  const ticket = randomBytes(32).toString('base64url')
  const expiresAt = now + SOCKET_TICKET_LIFETIME_MS
  issuedTickets.set(ticket, { jti: randomUUID(), userId, expiresAt })
  return { ticket, expiresAt: new Date(expiresAt).toISOString() }
}

export function consumeSocketTicket(ticket: string): { jti: string; userId: string } | undefined {
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

    // Deprecated compatibility path: older clients sent the one-use ticket as auth.token.
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string' || token.length === 0) {
      return next(new Error('INVALID_GATEWAY_TOKEN'))
    }

    const legacyTicket = consumeSocketTicket(token)
    if (legacyTicket) {
      socket.data.userId = legacyTicket.userId
      return next()
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