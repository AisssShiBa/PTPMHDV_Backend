import axios from 'axios';
import { internalKey } from '../config/secrets';

export class NotificationClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3006';
  }

  async send(userId: string, type: string, message: string, eventId?: string) {
    await axios.post(
      `${this.baseUrl}/api/notifications`,
      {
        userId,
        type,
        message,
        ...(eventId ? { eventId } : {})
      },
      {
        headers: {
          'X-Internal-Key': internalKey!
        }
      }
    );
  }
}
