import { createServer, type Server } from 'node:http'
import { expect, test } from 'vitest'
import app from '../src/app'

test('GET /', async () => {
    const res = await app.request('/')
    expect(await res.json()).toEqual({ message: 'Hello Hono!' })
})

test('GET /status_forward 非法 baseUrl 返回 400', async () => {
    const res = await app.request('/status_forward?baseUrl=not-a-url&token=t')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ action: 'error' })
})

test('GET /status_forward 拒绝非 http(s) 协议', async () => {
    const res = await app.request('/status_forward?baseUrl=data:application/json,{}&token=t')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ action: 'error', message: expect.stringContaining('Unsupported protocol') })
})

test('配置 AUTH_TOKEN 后要求 Bearer', async () => {
    process.env.AUTH_TOKEN = 'secret'
    try {
        const unauthorized = await app.request(`/status_forward?baseUrl=http://127.0.0.1:1&token=t`)
        expect(unauthorized.status).toBe(401)

        const wrong = await app.request(`/status_forward?baseUrl=http://127.0.0.1:1&token=t`, {
            headers: { Authorization: 'Bearer nope' },
        })
        expect(wrong.status).toBe(401)

        const passed = await app.request(`/status_forward?baseUrl=not-a-url&token=t`, {
            headers: { Authorization: 'Bearer secret' },
        })
        expect(passed.status).toBe(400)
    } finally {
        delete process.env.AUTH_TOKEN
    }
})

test('配置 BLOCK_PRIVATE_NETWORK 后拒绝局域网目标', async () => {
    process.env.BLOCK_PRIVATE_NETWORK = 'true'
    try {
        const res = await app.request('/status_forward?baseUrl=http://127.0.0.1:1&token=t')
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ action: 'error', message: expect.stringContaining('Private network') })
    } finally {
        delete process.env.BLOCK_PRIVATE_NETWORK
    }
})

test('转发在线状态并回显原始响应', async () => {
    let server: Server
    const baseUrl = await new Promise<string>((resolve) => {
        server = createServer((req, res) => {
            expect(req.url).toBe('/get_status')
            expect(req.headers.authorization).toBe('Bearer t')
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true } }))
        })
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            resolve(`http://127.0.0.1:${port}`)
        })
    })
    try {
        const res = await app.request(`/status_forward?baseUrl=${encodeURIComponent(baseUrl)}&token=t`)
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
            action: 'success',
            message: 'Forwarded status: online',
            raw: { status: 'ok', retcode: 0 },
        })
    } finally {
        server.close()
    }
})
