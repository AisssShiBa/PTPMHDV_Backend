import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import SwaggerParser from '@apidevtools/swagger-parser'

test('User and Merchant OpenAPI contracts validate and keep distinct operation IDs', async () => {
  const ids = new Set<string>()
  for (const path of ['docs/openapi.json', '../merchant-service/docs/openapi.json']) {
    const api = await SwaggerParser.validate(resolve(path))
    assert.equal((api as any).openapi, '3.0.3')
    for (const item of Object.values(api.paths || {})) {
      for (const operation of Object.values(item || {}) as any[]) {
        if (!operation?.operationId) continue
        assert.ok(!ids.has(operation.operationId), 'Operation IDs must remain unique when contracts are combined')
        ids.add(operation.operationId)
      }
    }
  }
  for (const id of ['getCurrentUser', 'getCurrentUserKyc', 'submitCurrentUserKyc', 'getMyMerchant', 'updateMerchantProfile']) {
    assert.ok(ids.has(id))
  }
})
