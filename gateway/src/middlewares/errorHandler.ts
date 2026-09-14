// D:\PTPMHDV\Backend\gateway\src\middlewares\errorHandler.ts
import { Request, Response, NextFunction } from 'express'
import { fail } from '../utils/response'

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
    const reqId = req.headers['x-request-id'] || 'N/A'
    console.error(`[Gateway Error] [ReqId: ${reqId}]:`, err.message || err)

    // Lỗi không thể kết nối tới service con (Service chưa bật hoặc bị chết)
    if (err.code === 'ECONNREFUSED') {
        return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Dịch vụ phía sau hiện không khả dụng')
    }

    // Lỗi service con xử lý quá lâu (Timeout)
    if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
        return fail(res, 504, 'GATEWAY_TIMEOUT', 'Dịch vụ phản hồi quá thời gian cho phép')
    }

    return fail(res, 500, 'INTERNAL_SERVER_ERROR', 'Lỗi hệ thống cổng Gateway')
}
