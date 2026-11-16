import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const ROOT_DIR = path.resolve(import.meta.dirname, '../..')

const envFile = path.join(ROOT_DIR, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

export const DATA_DIR = path.resolve(ROOT_DIR, process.env.AUTOMEDIA_DATA_DIR || 'data')
export const PORT = Number(process.env.AUTOMEDIA_PORT || 8686)
export const HOST = process.env.AUTOMEDIA_HOST || '0.0.0.0'
export const WEB_DIST = path.join(ROOT_DIR, 'web', 'dist')
export const MIGRATIONS_DIR = path.join(ROOT_DIR, 'server', 'drizzle')

/**
 * 访问密码：优先环境变量 AUTOMEDIA_PASSWORD（可写在根目录 .env），
 * 否则读 data/password.txt，文件不存在就随机生成一个。
 */
export function loadPassword(): { password: string; generated: boolean } {
  const fromEnv = process.env.AUTOMEDIA_PASSWORD?.trim()
  if (fromEnv) return { password: fromEnv, generated: false }
  mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, 'password.txt')
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim()
    if (saved) return { password: saved, generated: false }
  }
  const password = randomBytes(18).toString('base64url')
  writeFileSync(file, password + '\n', { mode: 0o600 })
  return { password, generated: true }
}
