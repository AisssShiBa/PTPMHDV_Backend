import axios from 'axios';

export class NotificationClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3006';
  }

  async send(userId: string, type: string, message: string) {
    await axios.post(
      `${this.baseUrl}/api/notifications`,
      {
        userId,
        type,
        message
      },
      {
        headers: {
          'X-Internal-Key': process.env.INTERNAL_KEY || 'f6f2f278e1bddbc7d16c19851cc828ce455015504709b35d232383543d6c1e68'
        }
      }
    );
  }
}
