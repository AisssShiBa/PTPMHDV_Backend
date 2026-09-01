import express from 'express'
import {
  signUp,
  signIn,
  refresh,
  signOut,
  refreshToken
} from '../controllers/authController'
const route = express.Router()
route.post('/signup', signUp)
route.post('/signin', signIn)
route.post('/refresh-token', refresh)
route.post('/signout', signOut)
route.post('/refresh', refreshToken)
export default route
