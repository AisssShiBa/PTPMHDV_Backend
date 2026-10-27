import { prisma } from '../config/prisma'
import { publishEvent } from '../lib/rabbitmq'

// Hằng số cấu hình hệ thống
const BATCH_SIZE = 20
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_RETRY_ATTEMPTS = 10

// Quản lý trạng thái bộ nhớ của Worker
let workerTimer: NodeJS.Timeout | null = null
let isProcessing = false

/**
 * OutboxWorker quản lý việc quét và đẩy sự kiện sang RabbitMQ
 * Tuân thủ đúng 100% khuôn mẫu Object Literal và Arrow Function như AuthService, PinService
 */
export const OutboxWorker = {
  /**
   * 1. Xử lý một đợt các sự kiện PENDING trong bảng Outbox
   */
  processBatch: async (): Promise<number> => {
    // Cơ chế Mutex Lock: Nếu đợt trước chưa xử lý xong thì bỏ qua đợt này (chống trùng lặp)
    if (isProcessing) return 0
    isProcessing = true

    let successCount = 0

    try {
      // Quét tối đa 20 sự kiện PENDING cũ nhất (FIFO - First In First Out)
      const pendingEvents = await prisma.authOutboxEvent.findMany({
        where: {
          status: 'PENDING'
        },
        take: BATCH_SIZE,
        orderBy: {
          createdAt: 'asc'
        }
      })

      if (pendingEvents.length === 0) {
        return 0
      }

      console.log(`[Auth Outbox] Đang xử lý ${pendingEvents.length} sự kiện tồn đọng...`)

      // Lần lượt gửi từng sự kiện lên RabbitMQ
      for (const event of pendingEvents) {
        try {
          const rawPayload = event.payload as Record<string, unknown>

          // Chuẩn hóa cấu trúc envelope sự kiện đồng bộ 100% với user-service & wallet-service
          const eventMessage = {
            eventId: event.id,
            eventType: event.eventType, // 'user.registered'
            eventVersion: 1,
            occurredAt: event.createdAt.toISOString(),
            data: {
              authUserId: event.aggregateId,
              email: rawPayload.email,
              username: rawPayload.username,
              firstName: rawPayload.firstName,
              lastName: rawPayload.lastName
            }
          }

          // Bắn lên RabbitMQ qua ConfirmChannel
          const isSent = await publishEvent(event.eventType, eventMessage, event.id)

          if (isSent) {
            // Bắn thành công: Cập nhật PUBLISHED và thời điểm phát
            await prisma.authOutboxEvent.update({
              where: { id: event.id },
              data: {
                status: 'PUBLISHED',
                publishedAt: new Date()
              }
            })
            successCount++
            console.log(`[Auth Outbox] Sự kiện ${event.eventType} (${event.id}) đã gửi thành công tới RabbitMQ.`)
          } else {
            // Gửi thất bại (RabbitMQ chưa sẵn sàng): Tăng biến attempts
            const nextAttempts = event.attempts + 1
            const shouldFail = nextAttempts >= MAX_RETRY_ATTEMPTS

            await prisma.authOutboxEvent.update({
              where: { id: event.id },
              data: {
                attempts: nextAttempts,
                status: shouldFail ? 'FAILED' : 'PENDING'
              }
            })

            if (shouldFail) {
              console.error(`[Auth Outbox] Sự kiện ${event.id} thất bại quá ${MAX_RETRY_ATTEMPTS} lần. Đã chuyển thành FAILED.`)
            }
          }
        } catch (eventError) {
          console.error(`[Auth Outbox] Lỗi xử lý sự kiện ${event.id}:`, eventError)
          await prisma.authOutboxEvent.update({
            where: { id: event.id },
            data: {
              attempts: { increment: 1 }
            }
          })
        }
      }
    } catch (dbError) {
      console.error('[Auth Outbox] Lỗi khi truy vấn Database Outbox:', dbError)
    } finally {
      isProcessing = false
    }

    return successCount
  },

  /**
   * 2. Khởi động tiến trình chạy ngầm quét Outbox định kỳ
   */
  start: (intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void => {
    if (workerTimer) {
      console.warn('[Auth Outbox] Worker đã đang chạy.')
      return
    }

    console.log(`[Auth Outbox] Khởi động Outbox Worker (chu kỳ quét: ${intervalMs}ms)...`)

    // Chạy ngay đợt đầu tiên khi khởi động
    void OutboxWorker.processBatch()

    // Lên lịch chạy định kỳ ngầm
    workerTimer = setInterval(() => {
      void OutboxWorker.processBatch()
    }, intervalMs)
  },

  /**
   * 3. Dừng tiến trình quét Outbox an toàn khi ứng dụng shutdown
   */
  stop: (): void => {
    if (workerTimer) {
      clearInterval(workerTimer)
      workerTimer = null
      console.log('[Auth Outbox] Đã dừng Outbox Worker an toàn.')
    }
  }
}
