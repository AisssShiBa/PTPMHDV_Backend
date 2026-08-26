import express from 'express'
import { signUp, signIn, refresh, signOut } from '../controllers/authController'
const route = express.Router()
route.post('/signup', signUp)
route.post('/signin', signIn)
route.post('/refresh-token', refresh)
route.post('/signout', signOut)
export default route
