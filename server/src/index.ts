import { existsSync } from 'node:fs'
import { buildApp, requestHandlerOf } from './app'
import { startScheduler } from './automation/automation'
import { openDb } from './db'
import { DATA_DIR, HOST, PORT, WEB_DIST, loadPassword } from './env'
import { describeRule, parseListen, startRestrictedListeners } from './listen'

openDb()
await startScheduler()
const { password, generated } = loadPassword()
const app = await buildApp({ password })

// 设置了 AUTOMEDIA_LISTEN：只监听 127.0.0.1 和本机上落在指定网段里的地址；没设置：按 AUTOMEDIA_HOST（默认所有地址）
const rules = parseListen(process.env.AUTOMEDIA_LISTEN)
if (!rules) await app.listen({ port: PORT, host: HOST })
else {
  await app.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`只监听内网地址（AUTOMEDIA_LISTEN）：127.0.0.1 和 ${rules.map(describeRule).join('、')} 里的本机地址`)
  const listeners = startRestrictedListeners({
    handler: requestHandlerOf(app),
    rules,
    port: PORT,
    template: app.server,
    log: (m) => console.log(`[listen] ${m}`),
  })
  if (!listeners.addresses().length)
    console.log('[listen] 现在本机没有这些网段里的地址，只有本机自己能访问；等网卡 / Tailscale 起来后会自动补上')
}

console.log(`automedia 已启动：http://localhost:${PORT}`)
console.log(`数据目录：${DATA_DIR}`)
if (generated) console.log(`首次启动，已生成访问密码：${password}\n（保存在 data/password.txt，也可以用环境变量 AUTOMEDIA_PASSWORD 指定）`)
if (!existsSync(WEB_DIST)) console.log('未找到前端构建产物（web/dist），当前只提供 API。开发时请用 pnpm :dev。')
