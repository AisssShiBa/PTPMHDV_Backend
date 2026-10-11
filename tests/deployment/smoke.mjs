import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const userRequire = createRequire(new URL('../../services/user-service/package.json', import.meta.url))
const merchantRequire = createRequire(new URL('../../services/merchant-service/package.json', import.meta.url))
const jwt = userRequire('jsonwebtoken')
const sharp = userRequire('sharp')
const amqp = userRequire('amqplib')
const { S3Client, PutObjectCommand } = userRequire('@aws-sdk/client-s3')
const config = userRequire('dotenv').parse(readFileSync(new URL('../../.cache/deployment/runtime.env', import.meta.url)))
const users = new (userRequire('@prisma/client').PrismaClient)({ datasources: { db: { url: 'postgresql://postgres:postgres@127.0.0.1:25434/user_service' } } })
const merchants = new (merchantRequire('@prisma/client').PrismaClient)({ datasources: { db: { url: 'postgresql://postgres:postgres@127.0.0.1:25434/merchant_service' } } })
const evidence = []
async function call(path, { method='GET', body, token, internal=false, expected=200, servicePort=13000 }={}) {
  const headers={}
  if (token) headers.authorization='Bearer '+token
  if (internal) headers['x-internal-key']=config.INTERNAL_KEY
  const form=body instanceof FormData
  if (body && !form) headers['content-type']='application/json'
  const response=await fetch('http://127.0.0.1:'+servicePort+path,{ method, headers,
    body:body ? (form ? body : JSON.stringify(body)) : undefined, signal:AbortSignal.timeout(15000) })
  const value=await response.json()
  evidence.push({method,path,status:response.status,code:value.error?.code})
  assert.equal(response.status,expected,method+' '+path+': '+JSON.stringify(value.error))
  return value.data
}
async function until(check) {
  const deadline=Date.now()+15000
  while (Date.now()<deadline) { if (await check()) return; await delay(150) }
  throw new Error('Runtime event processing timed out')
}
const owner=randomUUID()
const token=jwt.sign({userId:owner,role:'USER'},config.ACCESS_TOKEN_SECRET,{expiresIn:'5m'})
let connection
const s3=new S3Client({endpoint:'http://localhost:19003',region:'us-east-1',forcePathStyle:true,
  credentials:{accessKeyId:config.S3_ACCESS_KEY_ID,secretAccessKey:config.S3_SECRET_ACCESS_KEY}})
try {
  await call('/api/users/me',{expected:401})
  await call('/api/merchants/me',{expected:401})
  await call('/api/users/me',{servicePort:13002,token,expected:401})
  await call('/api/users',{method:'POST',internal:true,servicePort:13002,expected:201,
    body:{authUserId:owner,email:owner+'@runtime.test'}})
  const profile=await call('/api/users/me',{token})
  assert.equal(profile.authUserId,owner)
  assert.equal(profile.kycTier,0)
  assert.equal(profile.hasKycDocument,false)
  assert.equal(profile.kycObjectKey,undefined)
  assert.equal(await call('/api/merchants/me',{token}),null)
  const png=await sharp({create:{width:16,height:16,channels:3,background:'#eeeeee'}}).png().toBuffer()
  const form=new FormData()
  form.set('idNumber','RUNTIME-TEST-ONLY')
  form.set('document',new Blob([png],{type:'image/png'}),'synthetic.png')
  await call('/api/users/me/kyc',{method:'POST',token,body:form})
  const kyc=await call('/api/users/me/kyc',{token})
  assert.deepEqual(kyc,{kycStatus:'PENDING',kycTier:0,hasKycDocument:true})
  const document=await call('/api/users/by-auth/'+owner+'/kyc/document',{token})
  assert.equal(new URL(document.url).host,'localhost:19003')
  assert.equal((await fetch(document.url)).status,200)
  const unsigned=new URL(document.url); unsigned.search=''
  assert.equal((await fetch(unsigned)).status,403)
  await assert.rejects(s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:'outside-kyc/forbidden',Body:'denied'})),
    error=>error.$metadata?.httpStatusCode===403)
  await call('/api/users/'+profile.id+'/kyc-status',{method:'PATCH',servicePort:13002,internal:true,body:{kycStatus:'APPROVED'}})
  const merchant=await call('/api/merchants/register',{method:'POST',token,expected:201,body:{businessName:'Runtime '+owner}})
  await call('/api/merchants/'+merchant.id,{method:'PUT',token,body:{businessName:'Updated '+owner}})
  await call('/api/merchants/'+merchant.id+'/status',{method:'PATCH',servicePort:13003,internal:true,body:{status:'APPROVED'}})
  await until(async()=>await merchants.merchantOutboxEvent.count({where:{aggregateId:merchant.id,status:'PUBLISHED'}})===3)
  const events=await merchants.merchantOutboxEvent.findMany({where:{aggregateId:merchant.id},orderBy:{aggregateVersion:'asc'}})
  assert.deepEqual(events.map(event=>event.eventType),['merchant.registered','merchant.profile_updated','merchant.status_updated'])
  connection=await amqp.connect('amqp://'+config.RABBITMQ_USER+':'+config.RABBITMQ_PASS+'@127.0.0.1:25673')
  const channel=await connection.createConfirmChannel()
  const event={eventId:randomUUID(),eventType:'user.registered',eventVersion:1,occurredAt:new Date().toISOString(),
    data:{authUserId:randomUUID(),email:randomUUID()+'@runtime.test'}}
  for (let i=0;i<2;i++) channel.publish('finvault.events','user.registered',Buffer.from(JSON.stringify(event)),{persistent:true})
  await channel.waitForConfirms()
  await until(async()=>await users.consumedEvent.count({where:{id:event.eventId}})===1)
  assert.equal(await users.user.count({where:{authUserId:event.data.authUserId}}),1)
  const queue=await channel.checkQueue('finvault.demo.merchant-events.v1')
  assert.ok(queue.messageCount>=3)
  evidence.push({check:'runtime',compiledNode:true,productionKeys:true,privateStorage:true,scopedStorageUser:true,
    consumerInboxCount:1,merchantPublishedEvents:3,merchantQueueMessages:queue.messageCount})
  writeFileSync(new URL('../../.cache/deployment/smoke-result.json',import.meta.url),JSON.stringify(evidence,null,2))
  console.log('PASS: production images, Gateway identity, private KYC URL, scoped storage, internal review, consumer and publisher.')
} finally {
  await connection?.close()
  s3.destroy()
  await Promise.all([users.$disconnect(),merchants.$disconnect()])
}
