// utils/response.ts
import { Response } from 'express'

export const success = (
    res: Response,
    status: number,
    data: any,
    message?: string
) => {
    return res.status(status).json({ success: true, data, message })
}

export const fail = (
    res: Response,
    status: number,
    code: string,
    message: string
) => {
    return res.status(status).json({ success: false, error: { code, message } })
}
