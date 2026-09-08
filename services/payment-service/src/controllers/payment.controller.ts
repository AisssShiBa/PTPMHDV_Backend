import { Request, Response } from 'express';
import { paymentService } from '../services/payment.service';

export class PaymentController {
  async checkout(req: Request, res: Response): Promise<void> {
    try {
      const { merchantId, amount, orderId } = req.body;
      const idempotencyKey = req.headers['idempotency-key'] as string;

      if (!idempotencyKey) {
        res.status(400).json({ message: 'Idempotency-Key header is required' });
        return;
      }

      const result = await paymentService.checkout(merchantId, amount, orderId, idempotencyKey);
      res.status(201).json(result);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  }

  async confirm(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await paymentService.confirm(id);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  }

  async getPayment(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await paymentService.getPayment(id);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  }

  async getPayments(req: Request, res: Response): Promise<void> {
    try {
      const { userId, merchantId, page } = req.query;
      const result = await paymentService.getPayments({ userId, merchantId, page });
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  }

  async refund(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const result = await paymentService.refund(id, reason);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  }
}

export const paymentController = new PaymentController();
