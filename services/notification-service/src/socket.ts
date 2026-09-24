import type { Server } from 'socket.io'

export let notificationIO: Server | null = null

export const setNotificationIO = (io: Server) => {
  notificationIO = io
}