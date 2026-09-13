import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { env } from './config/env'
import { HttpExceptionFilter } from './common/http-exception.filter'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.setGlobalPrefix('api/v1')
  app.enableCors()
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true
    })
  )
  app.useGlobalFilters(new HttpExceptionFilter())
  app.enableShutdownHooks()

  await app.listen(env.port, '0.0.0.0')
}

bootstrap().catch((error: unknown) => {
  // Nest's logger is not yet available if application bootstrapping fails.
  console.error('Could not start wallet service', error)
  process.exit(1)
})
