import './setup'
import { stub } from './stub'
import { test } from 'node:test'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../src/app'
import { prisma } from '../src/config/prisma'
const ownerId = '10000000-0000-4000-8000-000000000001'
const id = '20000000-0000-4000-8000-000000000001'
const headers = (userId = ownerId) => ({ 'x-gateway-verified': 'true', authorization: 'Bearer ' + jwt.sign({ userId, role: 'USER' }, process.env.ACCESS_TOKEN_SECRET!) })
test('another owner cannot read or change banking details', async () => {
  stub(prisma.merchant, 'findFirst', async () => ({ id, ownerId, bankAccount: 'private', status: 'PENDING' }))
  const attacker = { ...headers('10000000-0000-4000-8000-000000000002'), 'x-user-id': ownerId }
  await request(app).get('/api/merchants/' + id).set(attacker).expect(403)
  await request(app).put('/api/merchants/' + id).set(attacker).send({ bankAccount: 'attacker' }).expect(403)
})
test('owner ID in the body cannot impersonate another owner', async () => {
  await request(app).post('/api/merchants/register').set(headers()).send({
    ownerId: '10000000-0000-4000-8000-000000000002', businessName: 'Shop'
  }).expect(403)
})
test('ordinary owner cannot approve merchant', async () => {
  await request(app).patch('/api/merchants/' + id + '/status').set(headers()).send({ status: 'APPROVED' }).expect(403)
})
