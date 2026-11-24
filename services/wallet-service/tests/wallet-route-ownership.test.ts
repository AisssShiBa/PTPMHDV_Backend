import assert from 'node:assert/strict';
import { once } from 'node:events';
import Module from 'node:module';
import { test } from 'node:test';
import express, { type RequestHandler, type Router } from 'express';
import type { GatewayAuthContext } from 'finvault-internal-auth';
import type { RequestWithContext } from '../src/middlewares/requestId';

const AN = '11111111-1111-4111-8111-111111111111';
const BINH = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

type Identity = {
  auth?: GatewayAuthContext;
  internal?: boolean;
};

// Exercise the real route registration, validation and authorization guards.
// Authentication is supplied by the harness; controllers are replaced so no
// database connection, wallet mutation or broker connection is needed.
function loadRouter(): Router {
  type Loader = (id: string, parent: NodeModule | null, isMain: boolean) => unknown;
  const moduleLoader = Module as typeof Module & { _load: Loader };
  const originalLoad = moduleLoader._load;
  const pass: RequestHandler = (_req, _res, next) => next();
  const controllerNames = [
    'create', 'lookupTransaction', 'getMeLedger', 'getMe', 'getBalance',
    'hold', 'extend', 'capture', 'release', 'refund', 'transfer',
    'credit', 'debit', 'history',
  ];
  const controllers = Object.fromEntries(controllerNames.map(name => [
    name,
    ((_req, res) => { res.json({ controller: name }); }) satisfies RequestHandler,
  ]));

  moduleLoader._load = function (id, parent, isMain) {
    if (parent?.filename.endsWith('wallet.routes.ts')) {
      if (id === '../middlewares/gatewayOrInternalAuth') {
        return { requireGatewayOrInternalKey: pass };
      }
      if (id === '../controllers/wallet.controller') return controllers;
    }
    return originalLoad.call(this, id, parent, isMain);
  };

  try {
    return (require('../src/routes/wallet.routes') as { default: Router }).default;
  } finally {
    moduleLoader._load = originalLoad;
  }
}

test('wallet router enforces ownership after route parameters are matched', async t => {
  const app = express();
  let identity: Identity | undefined;
  app.use(express.json());
  app.use((req, _res, next) => {
    const context = req as RequestWithContext;
    context.auth = identity?.auth;
    context.isInternalCall = identity?.internal;
    next();
  });
  app.use('/api/wallets', loadRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/wallets`;

  type Scenario = {
    name: string;
    actor?: Identity;
    path: string;
    method?: 'GET' | 'POST';
    body?: Record<string, string>;
    headers?: Record<string, string>;
    status: number;
    controller?: string;
  };
  const user: Identity = { auth: { userId: AN, role: 'USER', kycTier: 2, jti: 'test-user' } };
  const admin: Identity = { auth: { userId: ADMIN, role: 'ADMIN', kycTier: 2, jti: 'test-admin' } };
  const internal: Identity = { internal: true };
  const scenarios: Scenario[] = [
    { name: 'USER reads own balance', actor: user, path: `/${AN}/balance`, status: 200, controller: 'getBalance' },
    { name: 'USER cannot read another balance', actor: user, path: `/${BINH}/balance`, status: 403 },
    { name: 'USER reads own history', actor: user, path: `/${AN}/history`, status: 200, controller: 'history' },
    { name: 'USER cannot read another history', actor: user, path: `/${BINH}/history`, status: 403 },
    { name: 'missing identity is rejected', path: `/${BINH}/balance`, status: 401 },
    { name: 'identity headers cannot replace auth context', path: `/${BINH}/balance`, headers: { 'x-user-id': BINH, 'x-user-role': 'ADMIN' }, status: 401 },
    { name: 'ADMIN reads another balance', actor: admin, path: `/${BINH}/balance`, status: 200, controller: 'getBalance' },
    { name: 'ADMIN reads another history', actor: admin, path: `/${BINH}/history`, status: 200, controller: 'history' },
    { name: 'internal service reads balance', actor: internal, path: `/${BINH}/balance`, status: 200, controller: 'getBalance' },
    { name: 'USER keeps access to me', actor: user, path: '/me', status: 200, controller: 'getMe' },
    { name: 'USER keeps access to own ledger', actor: user, path: '/me/ledger', status: 200, controller: 'getMeLedger' },
    { name: 'USER cannot credit own wallet', actor: user, path: `/${AN}/credit`, method: 'POST', body: { amount: '1000', referenceId: 'ownership-test' }, status: 403 },
    { name: 'ADMIN can credit another wallet', actor: admin, path: `/${BINH}/credit`, method: 'POST', body: { amount: '1000', referenceId: 'ownership-test' }, status: 200, controller: 'credit' },
    { name: 'internal service can hold funds', actor: internal, path: `/${BINH}/hold`, method: 'POST', body: { amount: '1000', referenceId: 'ownership-test', expiresAt: '2099-01-01T00:00:00Z' }, status: 200, controller: 'hold' },
    { name: 'USER cannot create another wallet', actor: user, path: '/', method: 'POST', body: { userId: BINH }, status: 403 },
    { name: 'USER can create own wallet', actor: user, path: '/', method: 'POST', body: { userId: AN }, status: 200, controller: 'create' },
  ];

  try {
    for (const scenario of scenarios) {
      await t.test(scenario.name, async () => {
        identity = scenario.actor;
        const response = await fetch(baseUrl + scenario.path, {
          method: scenario.method ?? 'GET',
          headers: { 'content-type': 'application/json', ...scenario.headers },
          body: scenario.body ? JSON.stringify(scenario.body) : undefined,
        });
        const payload = await response.json() as {
          controller?: string;
          error?: { code: string };
        };
        assert.equal(response.status, scenario.status);
        if (scenario.controller) assert.equal(payload.controller, scenario.controller);
        if (scenario.status === 401) assert.equal(payload.error?.code, 'UNAUTHORIZED');
        if (scenario.status === 403) assert.equal(payload.error?.code, 'FORBIDDEN');
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
