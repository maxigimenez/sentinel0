import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decrypt, encrypt, encryptionKey, resetEncryptionKey, tokenPrefix } from '../src/crypto.js'

const KEY = randomBytes(32).toString('base64')

beforeEach(() => {
  process.env.SENTINEL0_SECRET_KEY = KEY
  resetEncryptionKey()
})

afterEach(() => {
  delete process.env.SENTINEL0_SECRET_KEY
  resetEncryptionKey()
})

describe('encryptionKey', () => {
  /*
   * The failure this guards is silent, not loud: a deployment that quietly
   * derived a key from nothing would encrypt every credential under a
   * guessable constant and look exactly like a working one.
   */
  it('refuses to invent a key', () => {
    delete process.env.SENTINEL0_SECRET_KEY
    resetEncryptionKey()
    expect(() => encryptionKey()).toThrow(/SENTINEL0_SECRET_KEY is required/)
  })

  it('rejects a key that is not 32 bytes', () => {
    process.env.SENTINEL0_SECRET_KEY = Buffer.from('too short').toString('base64')
    resetEncryptionKey()
    expect(() => encryptionKey()).toThrow(/must decode to 32 bytes/)
  })

  it('accepts hex as well as base64', () => {
    const hex = randomBytes(32).toString('hex')
    process.env.SENTINEL0_SECRET_KEY = hex
    resetEncryptionKey()
    expect(encryptionKey().toString('hex')).toBe(hex)
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips a token', () => {
    const token = 'github_pat_11ABCDEF0_abcdefghijklmnopqrstuvwxyz'
    expect(decrypt(encrypt(token))).toBe(token)
  })

  /*
   * A fresh IV per call. Without it two organizations storing the same token
   * would produce identical ciphertext, which leaks that they match.
   */
  it('produces different ciphertext for the same input', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'))
  })

  it('refuses a tampered ciphertext rather than returning a wrong token', () => {
    const encoded = encrypt('github_pat_original')
    const [version, iv, tag, body] = encoded.split('.')
    const flipped = Buffer.from(body, 'base64url')
    flipped[0] ^= 0xff
    expect(() => decrypt([version, iv, tag, flipped.toString('base64url')].join('.'))).toThrow()
  })

  it('refuses a value stored under a different key', () => {
    const encoded = encrypt('github_pat_original')
    process.env.SENTINEL0_SECRET_KEY = randomBytes(32).toString('base64')
    resetEncryptionKey()
    expect(() => decrypt(encoded)).toThrow()
  })

  it('rejects a payload that is not in this scheme', () => {
    expect(() => decrypt('not-encrypted-at-all')).toThrow(/not in a format/)
  })
})

describe('tokenPrefix', () => {
  /*
   * Long enough to tell a fine-grained token from a classic one, which is the
   * question someone looking at this field is actually asking.
   */
  it('keeps enough to identify the token type', () => {
    expect(tokenPrefix('github_pat_11ABCDEF0_secret')).toBe('github_pat_1')
    expect(tokenPrefix('ghp_abcdefghijklmnop')).toBe('ghp_abcdefgh')
  })

  it('does not pad a short value into looking longer', () => {
    expect(tokenPrefix('short')).toBe('short')
  })
})
