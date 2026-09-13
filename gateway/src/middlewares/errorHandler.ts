import { Request, Response, NextFunction } from 'express'
import { fail } from '../utils/response'

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    console.error(`[Error] [${req.headers['x-request-id']}]`, err.message || err)

    if (err.code === 'ECONNREFUSED') {
        return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Dịch vụ phía sau hiện đang bận hoặc gián đoạn kết nối')
    }

    if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
        return fail(res, 504, 'GATEWAY_TIMEOUT', 'Yêu cầu xử lý quá thời gian quy định')
    }

    return fail(res, 500, 'INTERNAL_SERVER_ERROR', err.message || 'Lỗi hệ thống Gateway')
}
