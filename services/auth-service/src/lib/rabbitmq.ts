import amqp, { ConfirmChannel } from 'amqplib'

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>

const EXCHANGE = process.env.EVENT_EXCHANGE || 'finvault.events'
const EXCHANGE_TYPE = 'topic'
const CONNECT_TIMEOUT_MS = 3000
const MAX_BACKOFF_MS = 30_000

let connection: AmqpConnection | null = null
let channel: ConfirmChannel | null = null
let isConnecting = false
let exchangeAsserted = false
let backoffMs = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function getRabbitUrl(): string {
  return process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectBackground()
  }, backoffMs)
  console.warn(`[RabbitMQ:auth] Thử kết nối lại sau ${backoffMs}ms...`)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

function resetState(): void {
  connection = null
  channel = null
  exchangeAsserted = false
  isConnecting = false
}

/**
 * Kết nối ngầm tới RabbitMQ trong background (Non-blocking)
 */
async function connectBackground(): Promise<void> {
  const url = getRabbitUrl()
  if (isConnecting) return
  isConnecting = true

  try {
    const connectWithTimeout = Promise.race([
      amqp.connect(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('RabbitMQ Connect Timeout')), CONNECT_TIMEOUT_MS)
      )
    ])

    const conn = await connectWithTimeout

    conn.on('error', (err) => {
      console.error('[RabbitMQ:auth] Lỗi kết nối:', err.message)
      resetState()
      scheduleReconnect()
    })

    conn.on('close', () => {
      console.warn('[RabbitMQ:auth] Kết nối RabbitMQ đã đóng.')
      resetState()
      scheduleReconnect()
    })

    const ch = await conn.createConfirmChannel()

    ch.on('error', (err) => {
      console.error('[RabbitMQ:auth] Lỗi Channel:', err.message)
      channel = null
      exchangeAsserted = false
      scheduleReconnect()
    })

    ch.on('close', () => {
      console.warn('[RabbitMQ:auth] Channel RabbitMQ đã đóng.')
      channel = null
      exchangeAsserted = false
    })

    // Xác nhận Topic Exchange tồn tại và bền vững (durable)
    await ch.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true })

    connection = conn as AmqpConnection
    channel = ch
    exchangeAsserted = true
    isConnecting = false
    backoffMs = 1000
    console.log(`[RabbitMQ:auth] Đã kết nối và xác nhận exchange: ${EXCHANGE}`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[RabbitMQ:auth] Kết nối thất bại:', message)
    resetState()
    scheduleReconnect()
  }
}

/**
 * Khởi tạo kết nối RabbitMQ khi ứng dụng khởi động
 */
export function initRabbitMQ(): void {
  void connectBackground()
}

/**
 * Bắn sự kiện lên RabbitMQ Topic Exchange kèm xác thực Confirm Channel
 * @param routingKey Tên routing key (ví dụ: 'user.registered')
 * @param payload Dữ liệu sự kiện
 * @param messageId ID duy nhất của sự kiện (thường là eventId / outbox.id)
 * @returns boolean true nếu broker đã nhận và confirm, ngược lại false
 */
export async function publishEvent(
  routingKey: string,
  payload: unknown,
  messageId: string
): Promise<boolean> {
  if (!channel || !exchangeAsserted) {
    void connectBackground()
    return false
  }

  const content = Buffer.from(JSON.stringify(payload))

  return new Promise((resolve) => {
    try {
      const drained = channel!.publish(
        EXCHANGE,
        routingKey,
        content,
        {
          persistent: true,
          contentType: 'application/json',
          messageId
        },
        (err) => {
          if (err) {
            console.error(`[RabbitMQ:auth] Lỗi confirm sự kiện ${messageId}:`, err.message)
            resolve(false)
          } else {
            resolve(true)
          }
        }
      )

      if (!drained) {
        channel!.once('drain', () => {
          // Callback confirm phía trên sẽ tự động xử lý resolve
        })
      }
    } catch (err: unknown) {
      console.error(`[RabbitMQ:auth] Ngoại lệ khi publish sự kiện ${messageId}:`, err)
      resolve(false)
    }
  })
}
