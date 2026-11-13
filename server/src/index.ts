// Server entry: migrations have applied by the time db/ is imported.
import { app } from './app'
import { PORT, VERSION } from './config'
import { wake } from './reports'

wake() // reports left pending by the last run
Bun.serve({ port: PORT, hostname: '0.0.0.0', fetch: app.fetch })
console.log(`VRCX Bot Blocker API ${VERSION} on :${PORT}`)
