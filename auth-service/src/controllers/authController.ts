import { Request, Response } from 'express'
import { prisma } from '../config/prisma'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
const ACCESS_TOKEN_EXPIRATION = '15m'
const REFRESH_TOKEN_EXPIRATION = 14 * 24 * 60 * 60 * 1000 // 14 ngày
export const signUp = async (req: Request, res: Response) => {
  try {
    const { email, password, username, firstName, lastName } = req.body
    if (!email || !password) {
      return res.status(400).json({ message: 'Email và mật khẩu là bắt buộc' })
    }
    const duplicateUser = await prisma.user.findUnique({ where: { email } })
    if (duplicateUser) {
      return res.status(409).json({ message: 'Người dùng đã tồn tại' })
    }
    const hashedPassword = await bcrypt.hash(password, 10)
    await prisma.user.create({
      data: {
        username,
        firstName,
        lastName,
        email,
        password: hashedPassword
      }
    })
    return res.status(200).json({ message: 'Đăng ký thành công' })
  } catch (error) {
    console.error('Lỗi đăng ký người dùng:', error)
    return res.status(500).json({ message: 'Lỗi hệ thống' })
  }
}
export const signIn = async (req: Request, res: Response) => {
  try {
    // Lấy thông tin đăng nhập từ request
    const { username, password } = req.body
    if (!username || !password) {
      return res
        .status(400)
        .json({ message: 'username và mật khẩu là bắt buộc' })
    }
    //lấy hasspassword so với password
    const user = await prisma.user.findUnique({ where: { username } })
    if (!user) {
      return res.status(401).json({ message: 'username  không tìm thấy' })
    }
    const passwordCorrect = await bcrypt.compare(password, user.password)
    if (!passwordCorrect) {
      return res.status(401).json({ message: 'Mật khẩu không đúng' })
    }
    //nếu khớp tạo access token với jwt
    const accessToken = jwt.sign(
      { userId: user.id },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: ACCESS_TOKEN_EXPIRATION }
    )
    //tạo refreshtoken
    const refreshToken = crypto.randomBytes(64).toString('hex')
    //tạo session mới để lưu refresh token
    await prisma.session.create({
      data: {
        refreshToken,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION),
        userId: user.id
      }
    })
    //trả về access token và refresh token về trong cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      //secure == false tránh lỗi khi chạy trên localhost, secure == true khi chạy trên production
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_TOKEN_EXPIRATION
    })
    return res.status(200).json({
      message: 'Đăng nhập thành công',
      accessToken
    })
    //trả access về trong res
  } catch (error) {
    console.error('Lỗi đăng nhập người dùng:', error)
    return res.status(500).json({ message: 'Lỗi hệ thống' })
  }
}
export const refresh = async (req: Request, res: Response) => {
  try {
    //lay refresh token từ cookie
    const refreshToken = req.cookies.refreshToken
    if (!refreshToken) {
      return res.status(401).json({ message: 'không tìm thấy refresh token' })
    }
    //tim session trong db với refresh token
    const session = await prisma.session.findUnique({ where: { refreshToken } })

    //kiem tra session có tồn tại và chưa hết hạn
    if (!session || session.expiresAt < new Date()) {
      return res
        .status(401)
        .json({ message: 'Refresh token không hợp lệ hoặc đã hết hạn' })
    }
    //tạo access token
    const accessToken = jwt.sign(
      { userId: session.userId },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: ACCESS_TOKEN_EXPIRATION }
    )
    //trả access về trong res
    return res.status(200).json({ accessToken })
  } catch (error) {
    console.error('Lỗi làm mới access token:', error)
    return res.status(500).json({ message: 'Lỗi hệ thống' })
  }
}
export const signOut = async (req: Request, res: Response) => {
  try {
    //lay refresh token từ cookie
    const token = req.cookies.refreshToken
    if (token) {
      //xoa refresh trong session
      await prisma.session.deleteMany({ where: { refreshToken: token } })
      //xoa cookie
      res.clearCookie('refreshToken', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production'
      })
    }
    return res.sendStatus(204)
  } catch (error) {
    console.error('Lỗi đăng xuất người dùng:', error)
    return res.status(500).json({ message: 'Lỗi hệ thống' })
  }
}
export const refreshToken = async (req: Request, res: Response) => {
  try {
    //lay refresh token từ cookie
    const token = req.cookies?.refreshToken as string | undefined
    if (!token) {
      return res.status(401).json({ message: 'token không tồn tại' })
    }
    //so sanh refresh token trong cookie với refresh token trong db
    const session = await prisma.session.findUnique({
      where: { refreshToken: token }
    })
    if (!session) {
      return res.status(401).json({ message: 'token hết hạn' })
    }
    //kiem tra refresh het han
    if (session.expiresAt < new Date()) {
      return res
        .status(401)
        .json({ message: 'token không hợp lệ hoặc hết hạn' })
    }
    // tao access token moi
    const accessToken = jwt.sign(
      { userId: session.userId },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: ACCESS_TOKEN_EXPIRATION }
    )
    //return access token moi
    return res.status(200).json({ accessToken })
  } catch (error) {
    console.error('"Lỗi refresh token người dùng:', error)
    return res.status(403).json({ message: 'Lỗi hệ thống' })
  }
}
