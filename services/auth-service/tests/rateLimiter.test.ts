import { test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { rateLimiter } from '../src/middlewares/rateLimiter'

test('signup/signin and PIN budgets do not interfere on the same IP', async () => {
  const app = express()
  app.get('/login', rateLimiter(60000, 3), (_req, res) => res.sendStatus(200))
  app.get('/pin', rateLimiter(60000, 1), (_req, res) => res.sendStatus(200))
  app.use((error: any, _req: any, res: any, _next: any) => res.sendStatus(error.status))
  for (let i = 0; i < 3; i++) await request(app).get('/login').expect(200)
  await request(app).get('/pin').expect(200)
  await request(app).get('/pin').expect(429)
  await request(app).get('/login').expect(429)
})

test('verified users have independent PIN budgets and aliases share one limiter', async () => {
  const app = express()
  const limiter = rateLimiter(60000, 1)
  // Controlled test middleware stands in for the already verified identity.
  const verified = (userId: string) => (req: any, _res: any, next: any) => { req.auth = { userId }; next() }
  app.get('/a', verified('a'), limiter, (_req, res) => res.sendStatus(200))
  app.get('/alias-a', verified('a'), limiter, (_req, res) => res.sendStatus(200))
  app.get('/b', verified('b'), limiter, (_req, res) => res.sendStatus(200))
  app.use((error: any, _req: any, res: any, _next: any) => res.sendStatus(error.status))
  await request(app).get('/a').expect(200)
  await request(app).get('/b').expect(200)
  await request(app).get('/alias-a').set('x-user-id', 'b').expect(429)
})
