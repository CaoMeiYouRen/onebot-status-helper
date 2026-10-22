import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { Bindings } from '../types'
import logger from '@/middlewares/logger'
import { parseTarget, requestUpstream, UpstreamError } from '@/utils/upstream'

const app = new Hono<{ Bindings: Bindings }>()

type RequestData = {
    baseUrl: string
    token: string
}

const DEFAULT_TIMEOUT = 60000
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3

function parseBoolean(value?: string): boolean {
    return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    const num = parseInt(value || '', 10)
    return Number.isFinite(num) && num > 0 ? num : fallback
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
    const num = parseInt(value || '', 10)
    return Number.isFinite(num) && num >= 0 ? num : fallback
}

function parseList(value?: string): string[] {
    return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
}

function safeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder()
    const left = encoder.encode(a)
    const right = encoder.encode(b)
    if (left.length !== right.length) {
        return false
    }
    let diff = 0
    for (let i = 0; i < left.length; i += 1) {
        diff |= left[i] ^ right[i]
    }
    return diff === 0
}

function isAuthorized(header: string | undefined, expected: string): boolean {
    const prefix = 'Bearer '
    if (!header?.startsWith(prefix)) {
        return false
    }
    return safeEqual(header.slice(prefix.length), expected)
}

app.on(['GET', 'POST'], '/status_forward', async (c) => {
    const config = env(c)

    // 可选鉴权：配置 AUTH_TOKEN 后，调用方必须携带 Authorization: Bearer <token>
    if (config.AUTH_TOKEN && !isAuthorized(c.req.header('authorization'), config.AUTH_TOKEN)) {
        return c.json({ action: 'error', message: 'Unauthorized' }, 401)
    }

    let data: RequestData = {} as RequestData
    if (c.req.method === 'GET') {
        data.baseUrl = c.req.query('baseUrl') ?? ''
        data.token = c.req.query('token') ?? ''
    } else if (c.req.method === 'POST') {
        try {
            data = await c.req.json() as RequestData
        } catch {
            return c.json({ action: 'error', message: 'Invalid JSON body' }, 400)
        }
    }
    const { baseUrl, token } = data || {} as RequestData
    if (!baseUrl || !token) {
        return c.json({ action: 'error', message: 'Missing baseUrl or token' })
    }
    try {
        const url = parseTarget(baseUrl)
        url.pathname = '/get_status'
        url.search = ''
        url.hash = ''

        const upstream = await requestUpstream(url, {
            token,
            timeoutMs: parsePositiveInt(config.TIMEOUT, DEFAULT_TIMEOUT),
            maxBytes: parsePositiveInt(config.MAX_UPSTREAM_BYTES, DEFAULT_MAX_BYTES),
            maxRedirects: parseNonNegativeInt(config.MAX_REDIRECTS, DEFAULT_MAX_REDIRECTS),
            allowedHosts: parseList(config.ALLOWED_HOSTS),
            blockPrivateNetwork: parseBoolean(config.BLOCK_PRIVATE_NETWORK),
        })

        if (upstream.ok) {
            let respData: { status?: string, retcode?: number, message?: string, data?: { online?: boolean } } | null
            try {
                respData = JSON.parse(upstream.text)
            } catch {
                return c.json({ action: 'error', message: 'Upstream returned invalid JSON' }, 400)
            }
            if (!respData || typeof respData !== 'object') {
                return c.json({ action: 'error', message: 'Upstream returned invalid JSON' }, 400)
            }
            if (respData.status === 'ok' && respData.retcode === 0) {
                if (respData.data && respData.data.online) {
                    logger.info('Forwarded status: online')
                    return c.json({ action: 'success', message: 'Forwarded status: online', raw: respData }, 200)
                }
                logger.info('Forwarded status: offline')
                return c.json({ action: 'success', message: 'Forwarded status: offline', raw: respData }, 400)
            }
            return c.json({ action: 'error', message: `Upstream error: ${respData.message || 'Unknown error'}` }, 400)
        }
        logger.error(`Upstream request failed with status ${upstream.status}: ${upstream.text}`)
        return c.json({ action: 'error', message: `Failed with status ${upstream.status}: ${upstream.text}` }, 400)

    } catch (error) {
        if (error instanceof UpstreamError) {
            logger.error(`Upstream request rejected: ${error.message}`)
            return c.json({ action: 'error', message: error.message }, 400)
        }
        logger.error(error)
        return c.json({ action: 'error', message: 'Request failed' }, 400)
    }
})

export default app
