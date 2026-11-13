// Server entry: migrations have applied by the time db/ is imported.
import { admin, isPrivate } from './admin'
import { app } from './app'
import { ADMIN_PORT, PORT, VERSION } from './config'
import { wake } from './reports'

wake() // reports left pending by the last run
Bun.serve({ port: PORT, hostname: '0.0.0.0', fetch: app.fetch })
// The management page: its own port, private addresses only (the port is never forwarded either).
Bun.serve({
    port: ADMIN_PORT,
    hostname: '0.0.0.0',
    fetch: (req, server) =>
        isPrivate(server.requestIP(req)?.address) ? admin.fetch(req) : new Response('Forbidden', { status: 403 })
})
console.log(`VRCX Bot Blocker API ${VERSION} on :${PORT}, management on :${ADMIN_PORT}`)
