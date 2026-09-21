import { Request, Response } from 'express';
import { PaymentService } from '../services/payment.service';

const paymentService = new PaymentService();

export const checkout = async (req: Request, res: Response) => {
  const { payment, replayed } = await paymentService.checkout({ ...req.body, userId: (req as any).userId });
  res.status(201).json({ success: true, data: { ...payment, replayed } });
};

export const confirm = async (req: Request, res: Response) => {
  const result = await paymentService.confirm(req.params.id as string);
  res.json({ success: true, data: result });
};

export const refund = async (req: Request, res: Response) => {
  const result = await paymentService.refund(req.params.id as string);
  res.json({ success: true, data: result });
};

export const cancel = async (req: Request, res: Response) => {
  const result = await paymentService.cancel(req.params.id as string);
  res.json({ success: true, data: result });
};

export const getById = async (req: Request, res: Response) => {
  const result = await paymentService.getById(req.params.id as string);
  if (!result) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Payment not found' } });
  }
  res.json(result);
};

export const list = async (req: Request, res: Response) => {
  const { userId, type, status } = req.query as any;
  const result = await paymentService.list(userId, type, status);
  res.json({ success: true, data: result });
};
