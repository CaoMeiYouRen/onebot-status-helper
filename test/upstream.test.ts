import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
    isPrivateHostname,
    matchAllowedHost,
    parseTarget,
    requestUpstream,
    UpstreamError,
} from '../src/utils/upstream'

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server, url: string }> {
    return new Promise((resolve) => {
        const server = createServer(handler)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            resolve({ server, url: `http://127.0.0.1:${port}` })
        })
    })
}

describe('isPrivateHostname', () => {
    test.each([
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        'localhost',
        'app.localhost',
        '[::1]',
        '::1',
        'fc00::1',
        'fd12:3456::1',
        'fe80::1',
        '::ffff:127.0.0.1',
    ])('阻断 %s', (host) => {
        expect(isPrivateHostname(host)).toBe(true)
    })

    test.each([
        '8.8.8.8',
        '1.1.1.1',
        '172.15.0.1',
        '172.32.0.1',
        'example.com',
        'onebot.example.com',
        '2001:4860:4860::8888',
    ])('放行 %s', (host) => {
        expect(isPrivateHostname(host)).toBe(false)
    })

    test('URL 规范化后的变形 IP 仍可识别', () => {
        expect(new URL('http://0x7f.1/').hostname).toBe('127.0.0.1')
        expect(isPrivateHostname(new URL('http://0x7f.1/').hostname)).toBe(true)
        expect(isPrivateHostname(new URL('http://2130706433/').hostname)).toBe(true)
    })
})

describe('matchAllowedHost', () => {
    const url = new URL('https://bot.example.com:8443/get_status')

    test('精确主机', () => {
        expect(matchAllowedHost(url, 'bot.example.com')).toBe(true)
        expect(matchAllowedHost(url, 'other.example.com')).toBe(false)
    })

    test('通配子域同时覆盖主域', () => {
        expect(matchAllowedHost(url, '*.example.com')).toBe(true)
        expect(matchAllowedHost(new URL('https://example.com/'), '*.example.com')).toBe(true)
        expect(matchAllowedHost(new URL('https://example.com.evil.com/'), '*.example.com')).toBe(false)
    })

    test('带端口规则精确匹配 host', () => {
        expect(matchAllowedHost(url, 'bot.example.com:8443')).toBe(true)
        expect(matchAllowedHost(url, 'bot.example.com:80')).toBe(false)
    })
})

describe('parseTarget', () => {
    test('非法 URL', () => {
        expect(() => parseTarget('not-a-url')).toThrow(UpstreamError)
    })

    test('非 http(s) 协议', () => {
        expect(() => parseTarget('ftp://example.com/')).toThrow(/Unsupported protocol/)
        expect(() => parseTarget('data:application/json,{}')).toThrow(/Unsupported protocol/)
    })

    test('合法地址', () => {
        expect(parseTarget('https://example.com/a').host).toBe('example.com')
    })
})

describe('requestUpstream', () => {
    let okServer: Server
    let okUrl: string
    let redirectServer: Server
    let redirectUrl: string
    let headerServer: Server
    let headerUrl: string
    let slowServer: Server
    let slowUrl: string
    let bigServer: Server
    let bigUrl: string
    let receivedAuth: (string | undefined)[] = []

    beforeAll(async () => {
        ({ server: okServer, url: okUrl } = await listen((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true } }))
        }));

        ({ server: headerServer, url: headerUrl } = await listen((req, res) => {
            receivedAuth.push(req.headers.authorization)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{}')
        }));

        ({ server: redirectServer, url: redirectUrl } = await listen((req, res) => {
            if (req.url === '/get_status') {
                // 跨端口（不同 host）跳转，同时检测凭据是否泄漏
                res.writeHead(302, { location: `${headerUrl}/elsewhere` })
                return res.end()
            }
            if (req.url === '/loop') {
                res.writeHead(302, { location: '/loop' })
                return res.end()
            }
            if (req.url === '/to-data') {
                res.writeHead(302, { location: 'data:application/json,{}' })
                return res.end()
            }
            res.writeHead(404).end()
        }));

        ({ server: slowServer, url: slowUrl } = await listen((_req, res) => {
            // 永不响应
            res.writeHead(200)
        }));

        ({ server: bigServer, url: bigUrl } = await listen((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('x'.repeat(4096))
        }))
    })

    afterAll(() => {
        okServer.close()
        redirectServer.close()
        headerServer.close()
        slowServer.close()
        bigServer.close()
    })

    test('正常返回响应体', async () => {
        const result = await requestUpstream(new URL(`${okUrl}/get_status`), { token: 't' })
        expect(result.ok).toBe(true)
        expect(JSON.parse(result.text).data.online).toBe(true)
    })

    test('跟随重定向但拒绝无限循环', async () => {
        await expect(requestUpstream(new URL(`${redirectUrl}/loop`), { maxRedirects: 2 }))
            .rejects.toThrow(/Too many redirects/)
    })

    test('跨主机重定向不转发凭据', async () => {
        receivedAuth = []
        await requestUpstream(new URL(`${redirectUrl}/get_status`), { token: 'secret' })
        expect(receivedAuth).toEqual([undefined])
    })

    test('重定向到非 http(s) 协议时拒绝', async () => {
        await expect(requestUpstream(new URL(`${redirectUrl}/to-data`), {}))
            .rejects.toThrow(/Unsupported protocol/)
    })

    test('开启后拒绝私网目标', async () => {
        await expect(requestUpstream(new URL(`${okUrl}/get_status`), { blockPrivateNetwork: true }))
            .rejects.toThrow(/Private network target/)
    })

    test('关闭时允许私网目标（默认行为）', async () => {
        const result = await requestUpstream(new URL(`${okUrl}/get_status`))
        expect(result.ok).toBe(true)
    })

    test('白名单外的主机被拒绝', async () => {
        await expect(requestUpstream(new URL(`${okUrl}/get_status`), { allowedHosts: ['example.com'] }))
            .rejects.toThrow(/not allowed/)
        const result = await requestUpstream(new URL(`${okUrl}/get_status`), { allowedHosts: ['127.0.0.1'] })
        expect(result.ok).toBe(true)
    })

    test('超时中断', async () => {
        await expect(requestUpstream(new URL(`${slowUrl}/get_status`), { timeoutMs: 200 }))
            .rejects.toThrow(/timed out/)
    })

    test('响应体超过上限时中断', async () => {
        await expect(requestUpstream(new URL(`${bigUrl}/get_status`), { maxBytes: 1024 }))
            .rejects.toThrow(/exceeds 1024 bytes/)
    })
})
