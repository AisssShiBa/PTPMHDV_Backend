import express from 'express'
import { authMe, test } from '../controllers/userController'
const route = express.Router()

route.get('/me', authMe)
route.get('/test', test)
export default route
