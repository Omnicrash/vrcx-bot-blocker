// The server's own VRChat session, used only to look players up. It logs in with the password
// and an authenticator code, keeps the cookies across restarts, and logs in again when VRChat
// drops them. Calls go out one at a time, at least VRC_GAP_MS apart.
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { COOKIE_FILE, USER_AGENT, VRC_API, VRC_GAP_MS, VRC_PASSWORD, VRC_TOTP_SECRET, VRC_USERNAME } from './config'
import type { Profile } from './rules'

export type LookupResult = { ok: true; user: Profile } | { ok: false; reason: 'missing' | 'unavailable' }

// RFC 6238 code for the current 30-second window.
export function totp(secretBase32: string, now = Date.now()): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = ''
    for (const c of secretBase32.replace(/=+$/, '')) {
        const v = alphabet.indexOf(c)
        if (v < 0) {
            throw new Error('authenticator secret is not base32')
        }
        bits += v.toString(2).padStart(5, '0')
    }
    const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? [])
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)))
    const mac = createHmac('sha1', key).update(counter).digest()
    const o = mac[mac.length - 1]! & 15
    return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

let cookies: Record<string, string> = load()
let lastCall = 0
let queue: Promise<unknown> = Promise.resolve()
export let loginState: 'ok' | 'not configured' | 'failed' | 'unknown' = VRC_USERNAME ? 'unknown' : 'not configured'

function load(): Record<string, string> {
    try {
        return JSON.parse(readFileSync(COOKIE_FILE, 'utf8'))
    } catch {
        return {}
    }
}

function save() {
    mkdirSync(dirname(COOKIE_FILE), { recursive: true })
    writeFileSync(COOKIE_FILE, JSON.stringify(cookies), { mode: 0o600 })
}

function cookieHeader() {
    return Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
}

function keepCookies(res: Response) {
    for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(';')
        const eq = pair!.indexOf('=')
        if (eq > 0) {
            cookies[pair!.slice(0, eq).trim()] = pair!.slice(eq + 1).trim()
        }
    }
    save()
}

// Spaces every call out, so no burst of reports reaches VRChat at once.
function paced<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
        const wait = lastCall + VRC_GAP_MS - Date.now()
        if (wait > 0) {
            await Bun.sleep(wait)
        }
        lastCall = Date.now()
        return fn()
    })
    queue = run.catch(() => {})
    return run
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${VRC_API}${path}`, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader(), ...(init.headers ?? {}) }
    })
    keepCookies(res)
    return res
}

async function login(): Promise<boolean> {
    if (!VRC_USERNAME) {
        return false
    }
    cookies = {}
    const basic = Buffer.from(`${encodeURIComponent(VRC_USERNAME)}:${encodeURIComponent(VRC_PASSWORD)}`).toString('base64')
    const first = await call('/auth/user', { headers: { Authorization: `Basic ${basic}` } })
    const body = (await first.json().catch(() => ({}))) as { requiresTwoFactorAuth?: string[]; id?: string }
    if (body.requiresTwoFactorAuth?.includes('totp')) {
        const verify = await call('/auth/twofactorauth/totp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: totp(VRC_TOTP_SECRET) })
        })
        const ok = ((await verify.json().catch(() => ({}))) as { verified?: boolean }).verified === true
        loginState = ok ? 'ok' : 'failed'
        return ok
    }
    loginState = body.id ? 'ok' : 'failed'
    return !!body.id
}

// Looks a player up, logging in (once) when the session has run out.
export function getUser(userId: string): Promise<LookupResult> {
    return paced(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await call(`/users/${encodeURIComponent(userId)}`)
            if (res.ok) {
                loginState = 'ok'
                return { ok: true, user: (await res.json()) as Profile }
            }
            if (res.status === 404) {
                return { ok: false, reason: 'missing' }
            }
            if (res.status === 401 && attempt === 0 && (await login())) {
                continue
            }
            if (res.status === 401) {
                loginState = 'failed'
            }
            break
        }
        return { ok: false, reason: 'unavailable' }
    })
}
