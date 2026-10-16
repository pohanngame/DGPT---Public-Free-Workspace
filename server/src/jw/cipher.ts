import { createCipheriv, randomBytes } from 'node:crypto'

/**
 * 认证页字符集：不含 I、L、O、l、o、0、1、9。
 * 前缀和向量都只能从这个集合里取，否则教务端会校验失败。
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678'
const PREFIX_LENGTH = 64
const IV_LENGTH = 16
const AES_KEY_BYTES = 16

/**
 * 复刻教务认证页：64 位字母前缀 + 密码，AES-128-CBC，密钥是页面盐的 UTF-8 字节，
 * 向量是 16 位字母。只返回 Base64 密文，不记录密码。
 */
export function encryptPassword(
  password: string,
  salt: string,
  random: (length: number) => string = defaultRandom,
): string {
  const key = Buffer.from(salt, 'utf8')
  if (key.length !== AES_KEY_BYTES) {
    throw new Error('pwdEncryptSalt must be 16 bytes')
  }
  const prefixed = random(PREFIX_LENGTH) + password
  const iv = Buffer.from(random(IV_LENGTH), 'utf8')
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([cipher.update(prefixed, 'utf8'), cipher.final()]).toString('base64')
}

function defaultRandom(length: number): string {
  const bytes = randomBytes(length)
  let text = ''
  for (const byte of bytes) {
    text += ALPHABET[byte % ALPHABET.length]
  }
  return text
}
