import app from './app'
import { env } from './config/env'

app.listen(env.port, () => {
  console.log(`Notification service chạy tại port ${env.port}`)
})