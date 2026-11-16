import { existsSync } from 'node:fs'
import { buildApp } from './app'
import { openDb } from './db'
import { DATA_DIR, HOST, PORT, WEB_DIST, loadPassword } from './env'

openDb()
const { password, generated } = loadPassword()
const app = await buildApp({ password })
await app.listen({ port: PORT, host: HOST })

console.log(`automedia 已启动：http://localhost:${PORT}`)
console.log(`数据目录：${DATA_DIR}`)
if (generated) console.log(`首次启动，已生成访问密码：${password}\n（保存在 data/password.txt，也可以用环境变量 AUTOMEDIA_PASSWORD 指定）`)
if (!existsSync(WEB_DIST)) console.log('未找到前端构建产物（web/dist），当前只提供 API。开发时请用 pnpm :dev。')
