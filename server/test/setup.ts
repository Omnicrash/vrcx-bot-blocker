// Runs before every test file: a throwaway database and a fake VRChat on a local port, which
// wants a password and a valid authenticator code before it answers any lookup.
import { createHmac } from 'node:crypto'
import type { Profile } from '../src/rules'

export const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
export const users = new Map<string, Profile>()
export const calls: string[] = []

function code(now = Date.now()) {
    // An independent TOTP, so the server's own implementation is what's under test.
    const key = Buffer.from('12345678901234567890')
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)))
    const mac = createHmac('sha1', key).update(counter).digest()
    const o = mac[mac.length - 1]! & 15
    return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

const fake = Bun.serve({
    port: 0,
    async fetch(req) {
        const url = new URL(req.url)
        const cookie = req.headers.get('cookie') ?? ''
        calls.push(`${req.method} ${url.pathname}`)
        if (url.pathname === '/api/1/auth/user') {
            const basic = req.headers.get('authorization')
            if (basic === `Basic ${Buffer.from('botcheck%40example.com:pa%3Ass').toString('base64')}`) {
                return Response.json({ requiresTwoFactorAuth: ['totp', 'otp'] }, { headers: { 'Set-Cookie': 'auth=half; Path=/' } })
            }
            return Response.json({ error: { message: 'Invalid Username/Email or Password' } }, { status: 401 })
        }
        if (url.pathname === '/api/1/auth/twofactorauth/totp/verify') {
            const body = (await req.json()) as { code: string }
            if (cookie.includes('auth=half') && body.code === code()) {
                return Response.json({ verified: true }, { headers: { 'Set-Cookie': 'auth=full; Path=/' } })
            }
            return Response.json({ verified: false }, { status: 400 })
        }
        const m = /^\/api\/1\/users\/(.+)$/.exec(url.pathname)
        if (m) {
            if (!cookie.includes('auth=full')) {
                return Response.json({ error: { message: 'Missing Credentials' } }, { status: 401 })
            }
            const user = users.get(decodeURIComponent(m[1]!))
            return user ? Response.json(user) : Response.json({ error: { message: 'User not found' } }, { status: 404 })
        }
        return new Response('not found', { status: 404 })
    }
})

process.env.VAPI_DB = ':memory:'
process.env.VAPI_COOKIE_FILE = `/tmp/vapi-test-cookie-${process.pid}.json`
process.env.VAPI_VRC_GAP_MS = '0'
process.env.VRC_API = `http://localhost:${fake.port}/api/1`
process.env.VRC_USERNAME = 'botcheck@example.com'
process.env.VRC_PASSWORD = 'pa:ss'
process.env.VRC_TOTP_SECRET = SECRET
process.env.VAPI_LIMIT_PER_INSTALL = '5'
process.env.VAPI_REVIEW_TOKEN = 'review-test-token'
