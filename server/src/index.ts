// Server entry: migrations have applied by the time db/ is imported.
import { admin, fromDocker } from './admin'
import { app } from './app'
import { ADMIN_PORT, PORT, VERSION } from './config'
import { startBackground } from './reports'

startBackground() // reports left pending by the last run, then the checker and the slow re-check
Bun.serve({ port: PORT, hostname: '0.0.0.0', fetch: app.fetch })
const seen = new Set<string>()
// The management page: its own port, reached only from NPMplus (OSign sign-in) and the daily review.
Bun.serve({
    port: ADMIN_PORT,
    hostname: '0.0.0.0',
    fetch: (req, server) => {
        const address = server.requestIP(req)?.address
        if (!seen.has(address ?? '')) {
            seen.add(address ?? '')
            console.log(`management page: first request from ${address}`) // shows whether Docker passes real addresses
        }
        return fromDocker(address) ? admin.fetch(req) : new Response('Forbidden', { status: 403 })
    }
})
console.log(`VRC Bot Blocker API ${VERSION} on :${PORT}, management on :${ADMIN_PORT}`)
