// Everything the environment decides.
const env = process.env

// Set by the image build (deploy/Dockerfile); /healthz reports it.
export const VERSION = env.VAPI_VERSION ?? 'dev'
export const PORT = Number(env.VAPI_PORT ?? 3060)
// The management page (reviewing group reports, taking entries off the list). Its port is only
// published on the LAN, and the page itself refuses anything but private addresses.
export const ADMIN_PORT = Number(env.VAPI_ADMIN_PORT ?? 3061)

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

// The bio words and sites the server itself accepts as grounds; the plugin's own list may hold more.
export const BIO_WORDS = (env.VAPI_BIO_WORDS ?? 'hexed.cc').split(',').map((w) => w.trim()).filter(Boolean)

// Reports per hour, per install and per address (Cloudflare passes the visitor's real one).
export const LIMIT_PER_INSTALL = Number(env.VAPI_LIMIT_PER_INSTALL ?? 120)
export const LIMIT_PER_IP = Number(env.VAPI_LIMIT_PER_IP ?? 300)
// The most entries one /v1/list answer carries; the plugin asks again for the rest.
export const LIST_PAGE = Number(env.VAPI_LIST_PAGE ?? 2000)
