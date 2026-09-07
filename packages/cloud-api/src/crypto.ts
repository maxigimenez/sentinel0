import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Symmetric encryption for the credentials the cloud stores on an org's behalf.
 *
 * The Slack webhook that preceded these is stored as plaintext and only ever
 * reported as "configured". That was a defensible trade for a URL whose worst
 * case is posting into a channel; it is not one for a token that can write to
 * every repository an operator can reach.
 *
 * Two-way, not a hash, because the point is to hand the plaintext back to the
 * runner. What encryption buys is that a leaked database dump is not a leaked
 * set of GitHub tokens -- the key lives in the environment, not in Postgres.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than yielding a plausible wrong token.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

/** `v1` names the scheme, so a future rotation can be told apart on sight. */
const VERSION = 'v1'

let cachedKey: Buffer | undefined

/**
 * The key, read once from `SENTINEL0_SECRET_KEY`.
 *
 * 32 bytes, base64 or hex. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Throws rather than falling back to a default or a derived-from-nothing key:
 * a deployment that quietly encrypted every credential under a guessable
 * constant would look exactly like a working one.
 */
export function encryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey
  }

  const raw = process.env.SENTINEL0_SECRET_KEY
  if (!raw) {
    throw new Error(
      'SENTINEL0_SECRET_KEY is required to store integration credentials. ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    )
  }

  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SENTINEL0_SECRET_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}. ` +
        'Provide 32 random bytes as base64 or hex.'
    )
  }

  cachedKey = key
  return key
}

/** Test seam: forget the cached key so a changed env var is picked up. */
export function resetEncryptionKey(): void {
  cachedKey = undefined
}

/** `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decrypt(encoded: string): string {
  const [version, iv, authTag, ciphertext] = encoded.split('.')
  if (version !== VERSION || !iv || !authTag || !ciphertext) {
    throw new Error('Stored credential is not in a format this build can read.')
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(authTag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * The visible part of a token.
 *
 * Enough to recognise which credential is installed, short enough to be
 * useless on its own. GitHub's own prefixes (`ghp_`, `github_pat_`) are longer
 * than four characters, so the type stays legible.
 */
export function tokenPrefix(token: string): string {
  return token.slice(0, 12)
}
