import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { WEB_DIST } from './env'
import { AppError } from './errors'
import { registerRoutes } from './routes'

const sha = (s: string) => createHash('sha256').update(s).digest()

export async function buildApp(opts: { password: string; serveWeb?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 32 * 1024 * 1024 })
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 100 } })

  // 认证：Authorization: Bearer <密码>。网页和直接调 API 用的是同一套。
  const expected = sha(opts.password)
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]
    if (!url.startsWith('/api/') || url === '/api/health') return
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token || !timingSafeEqual(sha(token), expected))
      return reply.code(401).send({ error: '密码不正确' })
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0]
      const where = issue?.path.length ? `${issue.path.join('.')}：` : ''
      return reply.code(400).send({ error: `${where}${issue?.message ?? '参数不合法'}` })
    }
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({ error: (err as Error).message })
    app.log.error(err)
    return reply.code(500).send({ error: (err as Error).message || '服务器内部错误' })
  })

  registerRoutes(app)

  const hasWeb = opts.serveWeb !== false && existsSync(WEB_DIST)
  if (hasWeb) await app.register(fastifyStatic, { root: WEB_DIST })
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !hasWeb || req.method !== 'GET')
      return reply.code(404).send({ error: '接口不存在' })
    return reply.sendFile('index.html') // SPA 前端路由
  })

  return app
}
