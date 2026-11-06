export type PushMessage = {
  userId: string
  deviceId: string
  title: string
  body: string
}

export interface PushProvider {
  send(input: PushMessage): Promise<{ delivered: boolean }>
}

export type LogPushProviderOptions = {
  log?: (message: string) => void
}

// Simulates FCM/Expo delivery for local development. The provider never
// receives or logs the push token; only opaque identifiers and content sizes
// are recorded so device credentials cannot leak through logs.
export class LogPushProvider implements PushProvider {
  private readonly log: (message: string) => void

  constructor(options: LogPushProviderOptions = {}) {
    this.log = options.log ?? (message => console.log(message))
  }

  async send(input: PushMessage): Promise<{ delivered: boolean }> {
    if (
      typeof input.userId !== 'string' || input.userId.trim().length === 0 ||
      typeof input.deviceId !== 'string' || input.deviceId.trim().length === 0 ||
      typeof input.title !== 'string' || typeof input.body !== 'string'
    ) {
      throw new TypeError('PushProvider requires userId, deviceId, title and body')
    }

    this.log(
      `[Push] simulated delivery user=${input.userId} device=${input.deviceId} ` +
      `titleLength=${input.title.length} bodyLength=${input.body.length}`
    )
    return { delivered: true }
  }
}
