// Signs the plugin for the updater: prints the base64 ECDSA P-256 signature of the file's bytes,
// made with the release key, and checks it against the public key the plugin carries.
// bun installer/sign.ts bot-blocker.js > bot-blocker.js.sig
import { readFileSync } from 'node:fs'

const file = process.argv[2]!
const keyFile = process.env.BOTB_RELEASE_KEY ?? `${process.env.HOME}/.config/botb/release-key.jwk`
const bytes = readFileSync(file)
const alg = { name: 'ECDSA', namedCurve: 'P-256' }
const priv = await crypto.subtle.importKey('jwk', JSON.parse(readFileSync(keyFile, 'utf8')), alg, false, ['sign'])
const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, bytes))

const m = /const RELEASE_KEY = (\{[^}]*\});/.exec(bytes.toString('utf8'))
const jwk = m && (Function(`return ${m[1]}`)() as JsonWebKey)
const pub = jwk && (await crypto.subtle.importKey('jwk', jwk, alg, false, ['verify']))
if (!pub || !(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, bytes))) {
    console.error(`${file}: its RELEASE_KEY doesn't match ${keyFile}`)
    process.exit(1)
}
console.log(Buffer.from(sig).toString('base64'))
