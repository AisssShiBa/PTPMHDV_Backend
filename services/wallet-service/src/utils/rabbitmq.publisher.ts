/**
 * RabbitMQ Singleton Publisher — wallet-service
 *
 * Bước 0 đối chiếu consumer (notification-service/src/services/rabbitmqConsumer.ts):
 *   - Exchange type : topic, durable: true
 *   - Queue        : `${RABBITMQ_QUEUE}.wallet.events` (mặc định: notification-service.wallet.events)
 *   - Binding key  : '#' (khớp mọi routing key)
 *   - Routing key  : dùng 'wallet.notification'
 *
 * Nguyên tắc:
 *   - Singleton connection + ConfirmChannel — không tạo mới mỗi lần publish
 *   - Non-blocking: nếu chưa kết nối → kích hoạt connect nền, trả false ngay
 *   - Backoff reconnect: 1s → 2s → 4s → ... tối đa 30s
 *   - Chỉ trả true sau khi broker confirm (publishConfirmed callback)
 *   - Không throw ra ngoài job, log lỗi nội bộ
 */

import amqp, { ConfirmChannel } from 'amqplib';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

const EXCHANGE = 'wallet.events';
const EXCHANGE_TYPE = 'topic';
const CONNECT_TIMEOUT_MS = 3000;
const MAX_BACKOFF_MS = 30_000;

let connection: AmqpConnection | null = null;
let channel: ConfirmChannel | null = null;
let isConnecting = false;
let exchangeAsserted = false;
let warnedOnce = false;
let backoffMs = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getRabbitUrl(): string | undefined {
  return process.env.RABBITMQ_URL;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectBackground();
  }, backoffMs);
  console.warn(`[RabbitMQ:wallet] Reconnecting in ${backoffMs}ms...`);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function resetState(): void {
  connection = null;
  channel = null;
  exchangeAsserted = false;
  isConnecting = false;
}

async function connectBackground(): Promise<void> {
  const url = getRabbitUrl();
  if (!url || isConnecting) return;
  isConnecting = true;

  try {
    const connectWithTimeout = Promise.race([
      amqp.connect(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connect timeout')), CONNECT_TIMEOUT_MS)
      ),
    ]);

    const conn = await connectWithTimeout;

    conn.on('error', (err) => {
      console.error('[RabbitMQ:wallet] Connection error:', err.message);
      resetState();
      scheduleReconnect();
    });
    conn.on('close', () => {
      console.warn('[RabbitMQ:wallet] Connection closed.');
      resetState();
      scheduleReconnect();
    });

    const ch = await conn.createConfirmChannel();

    ch.on('error', (err) => {
      console.error('[RabbitMQ:wallet] Channel error:', err.message);
      channel = null;
      exchangeAsserted = false;
      scheduleReconnect();
    });
    ch.on('close', () => {
      console.warn('[RabbitMQ:wallet] Channel closed.');
      channel = null;
      exchangeAsserted = false;
    });

    await ch.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });

    connection = conn as AmqpConnection;
    channel = ch;
    exchangeAsserted = true;
    isConnecting = false;
    backoffMs = 1000;
    console.log('[RabbitMQ:wallet] Connected and exchange asserted.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[RabbitMQ:wallet] Connection failed:', message);
    resetState();
    scheduleReconnect();
  }
}

function publishOnChannel(
  ch: ConfirmChannel,
  routingKey: string,
  content: Buffer,
  messageId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const drained = ch.publish(
      EXCHANGE,
      routingKey,
      content,
      { persistent: true, contentType: 'application/json', messageId },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );

    if (!drained) {
      ch.once('drain', () => {
        // callback confirm sẽ tự resolve/reject
      });
    }
  });
}

export interface PublishOptions {
  messageId?: string;
}

/**
 * Publish một message lên exchange wallet.events.
 * @returns true nếu broker đã confirm, false nếu không khả dụng hoặc lỗi
 */
export async function publish(
  exchange: string,
  routingKey: string,
  payload: Record<string, unknown>,
  opts: PublishOptions = {},
): Promise<boolean> {
  const url = getRabbitUrl();

  if (!url) {
    if (!warnedOnce) {
      console.warn('[RabbitMQ:wallet] RABBITMQ_URL không có — bỏ qua RabbitMQ, dùng HTTP fallback.');
      warnedOnce = true;
    }
    return false;
  }

  if (!channel || !exchangeAsserted) {
    void connectBackground();
    return false;
  }

  try {
    const content = Buffer.from(JSON.stringify(payload));
    const messageId = opts.messageId ?? `wallet-${Date.now()}`;
    await publishOnChannel(channel, routingKey, content, messageId);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[RabbitMQ:wallet] Publish failed:', message);
    channel = null;
    exchangeAsserted = false;
    scheduleReconnect();
    return false;
  }
}

/**
 * Đóng channel và connection gracefully — gọi khi SIGTERM/SIGINT
 */
export async function closeRabbitMQ(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    await channel?.close();
  } catch { /* ignore */ }
  try {
    await connection?.close();
  } catch { /* ignore */ }
  resetState();
  console.log('[RabbitMQ:wallet] Closed gracefully.');
}

// Khởi động kết nối ngay khi module được load (nếu có URL)
if (getRabbitUrl()) {
  void connectBackground();
}
