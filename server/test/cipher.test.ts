import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { test } from 'node:test'
import { encryptPassword } from '../src/jw/cipher.ts'

const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678'

test('encryptPassword matches AES-128-CBC of the supplied prefix and iv', () => {
  const prefix = ALPHABET.slice(0, 64)
  const iv = ALPHABET.slice(10, 26)
  const salt = '0123456789abcdef'
  const random = (length: number) => (length === 64 ? prefix : iv)
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(salt, 'utf8'), Buffer.from(iv, 'utf8'))
  const expected = Buffer.concat([cipher.update(prefix + 'pw', 'utf8'), cipher.final()]).toString(
    'base64',
  )
  assert.equal(encryptPassword('pw', salt, random), expected)
})

test('salt that is not 16 bytes throws', () => {
  assert.throws(() => encryptPassword('pw', 'short', () => ALPHABET[0] ?? 'A'))
})
