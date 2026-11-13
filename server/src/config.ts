import { readFileSync } from 'node:fs'

// Everything the environment decides.
const env = process.env

// Set by the image build (deploy/Dockerfile); /healthz reports it.
export const VERSION = env.VAPI_VERSION ?? 'dev'
export const PORT = Number(env.VAPI_PORT ?? 3060)
// The management page: its own port, only published on the LAN, behind a password whose hash
// (Bun.password, argon2) is read at each sign-in. Without one the page lets nobody in.
export const ADMIN_PORT = Number(env.VAPI_ADMIN_PORT ?? 3061)
// The daily review's token for /api on the management port: VAPI_REVIEW_TOKEN, else review.token
// next to the database. Without one the review API lets nobody in.
const REVIEW_TOKEN_FILE = env.VAPI_REVIEW_TOKEN_FILE ?? './data/review.token'
export function reviewToken(): string {
    if (env.VAPI_REVIEW_TOKEN) {
        return env.VAPI_REVIEW_TOKEN
    }
    try {
        return readFileSync(REVIEW_TOKEN_FILE, 'utf8').trim()
    } catch {
        return ''
    }
}


// The VRChat account the server looks players up with (an authenticator secret, so it can log
// in unattended). Empty: the server takes reports but can't verify them yet.
export const VRC_USERNAME = env.VRC_USERNAME ?? ''
export const VRC_PASSWORD = env.VRC_PASSWORD ?? ''
export const VRC_TOTP_SECRET = (env.VRC_TOTP_SECRET ?? '').replace(/[\s-]/g, '').toUpperCase()
export const VRC_API = env.VRC_API ?? 'https://api.vrchat.cloud/api/1'
// VRChat asks API clients to say who they are.
export const USER_AGENT = 'VRCXBotBlocker/2.0 (https://github.com/Omnicrash/vrcx-bot-blocker)'
// Where the login cookie survives restarts, next to the database.
export const COOKIE_FILE = env.VAPI_COOKIE_FILE ?? './data/vrchat-cookie.json'
// The least time between two VRChat calls, so a burst of reports never trips its limits.
export const VRC_GAP_MS = Number(env.VAPI_VRC_GAP_MS ?? 2000)

// The approved words the server starts with; after that the management page keeps the list.
export const BIO_WORDS = (env.VAPI_BIO_WORDS ?? 'hexed.cc').split(',').map((w) => w.trim()).filter(Boolean)

// Reports per hour, per install and per address (Cloudflare passes the visitor's real one).
export const LIMIT_PER_INSTALL = Number(env.VAPI_LIMIT_PER_INSTALL ?? 120)
export const LIMIT_PER_IP = Number(env.VAPI_LIMIT_PER_IP ?? 300)
// The most entries one /v1/list answer carries; the plugin asks again for the rest.
export const LIST_PAGE = Number(env.VAPI_LIST_PAGE ?? 2000)

// Protecting the VRChat account: a player is looked up once, then only listed entries are
// re-checked once their check is a week old, at most a few an hour and only with lookups to spare,
// all under a daily cap.
export const LOOKUPS_PER_DAY = Number(env.VAPI_LOOKUPS_PER_DAY ?? 300)
export const RECHECK_AFTER_DAYS = Number(env.VAPI_RECHECK_AFTER_DAYS ?? 7)
export const RECHECK_PER_HOUR = Number(env.VAPI_RECHECK_PER_HOUR ?? 6)
