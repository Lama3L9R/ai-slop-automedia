import http from 'node:http'
import net from 'node:net'
import os from 'node:os'

/**
 * 「只监听内网地址」。
 *
 * AUTOMEDIA_LISTEN 是一串用逗号分隔的地址或网段。设置之后，服务不再监听 0.0.0.0，
 * 而是只绑定本机上落在这些网段里的地址（外加 127.0.0.1），并且只接受来自这些网段的连接。
 *
 * 一项可以写成：
 *   192.168.5.0/24        CIDR
 *   192.168.5.255         广播地址的写法：末尾连续的 255 表示「这一段任意」，等同于上面那个 /24
 *   100.99.255.255        同理，等同于 100.99.0.0/16
 *   192.168.5.3           单个地址
 */
export interface ListenRule {
  /** 用户写的原文，报错和日志里用 */
  raw: string
  network: string
  prefix: number
  family: 'ipv4' | 'ipv6'
}

function parseEntry(raw: string): ListenRule {
  const bad = () => new Error(`AUTOMEDIA_LISTEN 里的「${raw}」不是合法的地址或网段`)
  const [addr, prefixText, extra] = raw.split('/')
  const version = net.isIP(addr)
  if (!version || extra !== undefined) throw bad()
  const family = version === 4 ? 'ipv4' : 'ipv6'
  const bits = version === 4 ? 32 : 128

  if (prefixText !== undefined) {
    const prefix = Number(prefixText)
    if (!/^\d+$/.test(prefixText) || prefix > bits) throw bad()
    return { raw, network: addr, prefix, family }
  }
  if (version === 4) {
    // 末尾连续的 255 当作通配：192.168.5.255 → 192.168.5.0/24
    const octets = addr.split('.').map(Number)
    let wild = 0
    while (wild < 4 && octets[3 - wild] === 255) wild++
    if (wild) {
      for (let i = 4 - wild; i < 4; i++) octets[i] = 0
      return { raw, network: octets.join('.'), prefix: 32 - wild * 8, family }
    }
  }
  return { raw, network: addr, prefix: bits, family }
}

/** 没设置（或是空串）返回 null，表示不限制 */
export function parseListen(value: string | undefined): ListenRule[] | null {
  const entries = (value ?? '').split(/[,\s]+/).filter(Boolean)
  return entries.length ? entries.map(parseEntry) : null
}

export const describeRule = (r: ListenRule) => `${r.network}/${r.prefix}`

/** 浏览器从 IPv4 连过来时，Node 给的地址可能是 ::ffff:192.168.5.3 这种形式 */
const normalize = (ip: string) => (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip)

export function matcher(rules: ListenRule[]): (ip: string | undefined) => boolean {
  const list = new net.BlockList()
  for (const r of rules) list.addSubnet(r.network, r.prefix, r.family)
  return (ip) => {
    if (!ip) return false
    const addr = normalize(ip)
    const version = net.isIP(addr)
    return version !== 0 && list.check(addr, version === 4 ? 'ipv4' : 'ipv6')
  }
}

const isLoopback = (ip: string | undefined) => {
  const addr = normalize(ip ?? '')
  return addr === '::1' || addr.startsWith('127.')
}

type Interfaces = ReturnType<typeof os.networkInterfaces>

/** 本机网卡上落在这些网段里的地址 */
export function localAddresses(rules: ListenRule[], interfaces: Interfaces = os.networkInterfaces()): string[] {
  const inside = matcher(rules)
  const out = new Set<string>()
  for (const list of Object.values(interfaces))
    for (const a of list ?? []) {
      // 带 scope 的 IPv6 链路本地地址绑定起来麻烦，也不是这里要解决的场景
      if (a.family === 'IPv6' && a.scopeid) continue
      if (inside(a.address)) out.add(a.address)
    }
  return [...out]
}

export interface RestrictedListeners {
  /** 当前实际在监听的地址（不含 127.0.0.1，那个由主服务负责） */
  addresses(): string[]
  /** 地址 → 实际端口（测试里用端口 0 时需要） */
  portOf(address: string): number | undefined
  stop(): void
}

/**
 * 在每个符合条件的本机地址上各起一个 HTTP 服务，共用同一个请求处理函数。
 * 网卡是会变的（Tailscale 可能比本服务晚起来，Wi-Fi 会重连），所以定期重新扫描：
 * 新出现的地址补上监听，消失的地址关掉。
 */
export function startRestrictedListeners(opts: {
  handler: http.RequestListener
  rules: ListenRule[]
  port: number
  /** 照着它设置超时等参数，和主服务保持一致 */
  template?: http.Server
  log?: (message: string) => void
  interfaces?: () => Interfaces
  includeLoopback?: boolean
  rescanMs?: number
}): RestrictedListeners {
  const { handler, rules, port, template, log = () => {} } = opts
  const inside = matcher(rules)
  const servers = new Map<string, http.Server>()
  const complained = new Set<string>()

  const open = (address: string) => {
    const server = http.createServer(handler)
    if (template) {
      server.requestTimeout = template.requestTimeout
      server.headersTimeout = template.headersTimeout
      server.keepAliveTimeout = template.keepAliveTimeout
      server.timeout = template.timeout
    }
    // 绑在内网地址上不等于来的都是内网的人（比如路由器做了端口转发），所以来源地址也要查
    server.on('connection', (socket) => {
      if (!inside(socket.remoteAddress) && !isLoopback(socket.remoteAddress)) socket.destroy()
    })
    server.on('error', (e: NodeJS.ErrnoException) => {
      servers.delete(address)
      if (!complained.has(address)) log(`无法监听 ${address}:${port}（${e.code ?? e.message}），稍后重试`)
      complained.add(address)
    })
    server.listen(port, address, () => {
      complained.delete(address)
      const actual = (server.address() as net.AddressInfo).port
      log(`监听 http://${address.includes(':') ? `[${address}]` : address}:${actual}`)
    })
    servers.set(address, server)
  }

  const sync = () => {
    // 127.0.0.1 由主服务监听，这里不重复绑（测试里没有主服务，所以可以要求包含）
    const want = new Set(
      localAddresses(rules, opts.interfaces?.()).filter((a) => opts.includeLoopback || !isLoopback(a)),
    )
    for (const [address, server] of servers) {
      if (want.has(address)) continue
      server.close()
      server.closeAllConnections()
      servers.delete(address)
      log(`不再监听 ${address}（这个地址已经不在本机上了）`)
    }
    for (const address of want) if (!servers.has(address)) open(address)
  }

  sync()
  const timer = setInterval(sync, opts.rescanMs ?? 30_000)
  timer.unref()

  return {
    addresses: () => [...servers.keys()],
    portOf: (address) => (servers.get(address)?.address() as net.AddressInfo | null)?.port,
    stop() {
      clearInterval(timer)
      for (const server of servers.values()) {
        server.close()
        server.closeAllConnections()
      }
      servers.clear()
    },
  }
}
