import { PrismaClient, TopupStatus } from '@prisma/client';
import { DomainException } from '../utils/domain.exception';
import { WalletClient } from '../clients/wallet.client';
import * as crypto from 'crypto';
import querystring from 'querystring';

const prisma = new PrismaClient();
const walletClient = new WalletClient();

export class TopupService {
  async createTopup(userId: string, amount: number, ipAddr: string) {
    const tmnCode = process.env.VNP_TMN_CODE?.trim();
    const secretKey = process.env.VNP_HASH_SECRET?.trim();
    const vnpUrl = process.env.VNP_URL?.trim();
    const returnUrl = process.env.VNP_RETURN_URL?.trim();

    if (!tmnCode || !secretKey || !vnpUrl || !returnUrl) {
      throw new DomainException(500, 'SERVER_ERROR', 'VNPAY config missing');
    }

    const code = 'NAP' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const createDate = this.formatDate(new Date());
    const expireDate = this.formatDate(expiresAt);

    const topup = await prisma.topupRequest.create({
      data: {
        userId,
        amount,
        code,
        expiresAt,
        status: TopupStatus.PENDING,
        auditLogs: {
          create: {
            actorId: userId,
            action: 'CREATE',
            toStatus: TopupStatus.PENDING,
          }
        }
      }
    });

    let vnp_Params: any = {};
    vnp_Params['vnp_Version'] = '2.1.0';
    vnp_Params['vnp_Command'] = 'pay';
    vnp_Params['vnp_TmnCode'] = tmnCode;
    vnp_Params['vnp_Locale'] = 'vn';
    vnp_Params['vnp_CurrCode'] = 'VND';
    vnp_Params['vnp_TxnRef'] = code;
    vnp_Params['vnp_OrderInfo'] = 'Nap tien vao vi ' + code;
    vnp_Params['vnp_OrderType'] = 'other';
    vnp_Params['vnp_Amount'] = Math.floor(amount * 100);
    vnp_Params['vnp_ReturnUrl'] = returnUrl;
    vnp_Params['vnp_IpAddr'] = ipAddr;
    vnp_Params['vnp_CreateDate'] = createDate;
    vnp_Params['vnp_ExpireDate'] = expireDate;

    vnp_Params = this.sortObject(vnp_Params);

    // Build signData: encode value with %20 as + (VNPAY spec)
    const signData = Object.keys(vnp_Params)
      .map(key => `${key}=${encodeURIComponent(vnp_Params[key]).replace(/%20/g, '+')}`)
      .join('&');
    const hmac = crypto.createHmac('sha512', secretKey);
    const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

    // Build payment URL: add hash then use URLSearchParams for correct encoding
    const allParams: any = { ...vnp_Params, vnp_SecureHash: signed };
    const paymentUrl = vnpUrl + '?' + new URLSearchParams(allParams).toString();

    await prisma.topupRequest.update({ 
      where: { id: topup.id }, 
      data: { paymentUrl } 
    });

    return { topupId: topup.id, paymentUrl };
  }

  async handleVnpayIpn(queryArgs: any) {
    let vnp_Params = { ...queryArgs };
    const secureHash = vnp_Params['vnp_SecureHash'];

    delete vnp_Params['vnp_SecureHash'];
    delete vnp_Params['vnp_SecureHashType'];

    vnp_Params = this.sortObject(vnp_Params);
    const secretKey = process.env.VNP_HASH_SECRET?.trim();
    const signData = Object.keys(vnp_Params)
      .map(key => `${key}=${encodeURIComponent(vnp_Params[key]).replace(/%20/g, '+')}`)
      .join('&');
    const hmac = crypto.createHmac('sha512', secretKey as string);
    const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

    if (secureHash !== signed) {
      return { RspCode: '97', Message: 'Invalid signature' };
    }

    const orderId = vnp_Params['vnp_TxnRef'];
    const rspCode = vnp_Params['vnp_ResponseCode'];
    const vnpAmount = parseInt(vnp_Params['vnp_Amount']);

    const topup = await prisma.topupRequest.findUnique({ where: { code: orderId } });
    if (!topup) {
      return { RspCode: '01', Message: 'Order not found' };
    }

    if (topup.amount.toNumber() * 100 !== vnpAmount) {
      return { RspCode: '04', Message: 'Invalid amount' };
    }

    if (topup.status !== TopupStatus.PENDING && topup.status !== TopupStatus.PROCESSING) {
      return { RspCode: '02', Message: 'Order already confirmed' };
    }

    if (rspCode === '00') {
      // success case
      const processingResult = await prisma.$executeRaw`
        UPDATE "TopupRequest"
        SET status = 'PROCESSING', "updatedAt" = NOW()
        WHERE id = ${topup.id}::uuid AND status = 'PENDING'
      `;
      // Nếu không update được tức là có process khác đã update (RspCode: '02')
      if (processingResult === 0 && topup.status === TopupStatus.PENDING) {
        return { RspCode: '02', Message: 'Order already confirmed' };
      }

      try {
        const walletRes = await walletClient.topupCredit(topup.userId, topup.amount.toString(), topup.code);
        if (!walletRes.success) {
           await prisma.topupRequest.update({
             where: { id: topup.id },
             data: { 
               status: TopupStatus.FAILED, 
               vnpResponseCode: rspCode,
               auditLogs: { create: { actorId: 'SYSTEM', action: 'WALLET_ERROR', toStatus: TopupStatus.FAILED, reason: walletRes.errorData?.error?.message } } 
             }
           });
           return { RspCode: '00', Message: 'Confirm Success' };
        }

        await prisma.topupRequest.update({
          where: { id: topup.id },
          data: {
            status: TopupStatus.APPROVED,
            vnpTransactionNo: vnp_Params['vnp_TransactionNo'],
            vnpBankCode: vnp_Params['vnp_BankCode'],
            vnpPayDate: vnp_Params['vnp_PayDate'],
            vnpResponseCode: rspCode,
            walletTransactionId: walletRes.data?.data?.transactionId,
            approvedAt: new Date(),
            approvedBy: 'VNPAY_SYSTEM',
            auditLogs: { create: { actorId: 'SYSTEM', action: 'VNPAY_IPN_SUCCESS', toStatus: TopupStatus.APPROVED } }
          }
        });
        return { RspCode: '00', Message: 'Confirm Success' };
      } catch (error) {
        // Network error when calling wallet -> keep PROCESSING, return 99 to let VNPAY retry
        return { RspCode: '99', Message: 'Unknown error' };
      }
    } else {
      // failed payment case
      await prisma.topupRequest.update({
        where: { id: topup.id },
        data: {
          status: TopupStatus.FAILED,
          vnpTransactionNo: vnp_Params['vnp_TransactionNo'],
          vnpBankCode: vnp_Params['vnp_BankCode'],
          vnpPayDate: vnp_Params['vnp_PayDate'],
          vnpResponseCode: rspCode,
          auditLogs: { create: { actorId: 'SYSTEM', action: 'VNPAY_IPN_FAILED', toStatus: TopupStatus.FAILED } }
        }
      });
      return { RspCode: '00', Message: 'Confirm Success' };
    }
  }

  async handleVnpayReturn(queryArgs: any) {
    let vnp_Params = { ...queryArgs };
    const secureHash = vnp_Params['vnp_SecureHash'];

    delete vnp_Params['vnp_SecureHash'];
    delete vnp_Params['vnp_SecureHashType'];

    vnp_Params = this.sortObject(vnp_Params);
    const secretKey = process.env.VNP_HASH_SECRET?.trim();
    const signData = Object.keys(vnp_Params)
      .map(key => `${key}=${encodeURIComponent(vnp_Params[key]).replace(/%20/g, '+')}`)
      .join('&');
    const hmac = crypto.createHmac('sha512', secretKey as string);
    const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

    if (secureHash !== signed) {
      throw new DomainException(400, 'INVALID_SIGNATURE', 'Chữ ký VNPAY không hợp lệ');
    }
    
    return vnp_Params;
  }

  async getTopup(id: string, userId: string) {
    const topup = await prisma.topupRequest.findUnique({ where: { id } });
    if (!topup) throw new DomainException(404, 'NOT_FOUND', 'Topup request not found');
    if (topup.userId !== userId) throw new DomainException(403, 'FORBIDDEN', 'Access denied');
    return topup;
  }

  async getMyTopups(userId: string) {
    return prisma.topupRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getAdminTopups(status?: string) {
    const whereClause = status ? { status: status as TopupStatus } : {};
    return prisma.topupRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' }
    });
  }

  async approveTopup(id: string, adminId: string) {
    throw new DomainException(400, 'NOT_ALLOWED', 'Manual approve is disabled for VNPAY integration. Use for resolving stuck orders only.');
  }

  async rejectTopup(id: string, adminId: string, reason: string) {
    throw new DomainException(400, 'NOT_ALLOWED', 'Manual reject is disabled for VNPAY integration.');
  }

  private sortObject(obj: any) {
    // Chỉ sort key theo alphabet, giữ nguyên value thô
    // Việc encode sẽ được thực hiện khi build signData
    const sorted: Record<string, string> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sorted[key] = String(obj[key]);
    }
    return sorted;
  }

  private formatDate(date: Date) {
    // Chuyển đổi sang múi giờ Việt Nam (UTC+7)
    const tzOffset = 7 * 60; // 7 hours in minutes
    const localTime = new Date(date.getTime() + tzOffset * 60000);
    
    const yyyy = localTime.getUTCFullYear().toString();
    const mm = (localTime.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = localTime.getUTCDate().toString().padStart(2, '0');
    const hh = localTime.getUTCHours().toString().padStart(2, '0');
    const min = localTime.getUTCMinutes().toString().padStart(2, '0');
    const ss = localTime.getUTCSeconds().toString().padStart(2, '0');
    return yyyy + mm + dd + hh + min + ss;
  }
}
