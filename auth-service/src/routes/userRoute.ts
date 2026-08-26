import express from 'express'
import { authMe } from '../controllers/userController'
const route = express.Router()

route.get('/me', authMe)
export default route
