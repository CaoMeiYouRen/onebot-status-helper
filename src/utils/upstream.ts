/**
 * 上游请求工具：在 fetch 之上补齐 SSRF 防护。
 *
 * 注意：fetch 会根据响应头自动解压（包含 br），改请求头无法关闭，
 * Brotli 解码器本身的修复依赖运行时版本（Node >= 24.22.1）。
 * 这里负责的是“能访问哪里”，以及响应体大小、重定向和超时。
 */

export class UpstreamError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UpstreamError'
    }
}

export interface UpstreamOptions {
    /** 发给上游的 OneBot access token */
    token?: string
    /** 整条请求链（含重定向与响应体读取）的总超时 */
    timeoutMs?: number
    /** 响应体字节上限 */
    maxBytes?: number
    /** 最多跟随的重定向次数 */
    maxRedirects?: number
    /** 允许的主机白名单，支持 `example.com`、`example.com:8080`、`*.example.com` */
    allowedHosts?: string[]
    /** 是否拒绝回环、私网、链路本地等目标 */
    blockPrivateNetwork?: boolean
}

export interface UpstreamResult {
    status: number
    ok: boolean
    text: string
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

const DEFAULT_TIMEOUT = 60000
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3

export function parseTarget(input: string): URL {
    let url: URL
    try {
        url = new URL(input)
    } catch {
        throw new UpstreamError('Invalid baseUrl')
    }
    assertSupportedProtocol(url)
    return url
}

export function assertSupportedProtocol(url: URL) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UpstreamError(`Unsupported protocol: ${url.protocol}`)
    }
}

export function assertAllowedTarget(url: URL, allowedHosts?: string[], blockPrivateNetwork = false) {
    // 每一跳都要校验，避免重定向把请求带到 file:/data: 等协议
    assertSupportedProtocol(url)
    if (allowedHosts?.length && !allowedHosts.some((host) => matchAllowedHost(url, host))) {
        throw new UpstreamError(`Target is not allowed: ${url.host}`)
    }
    if (blockPrivateNetwork && isPrivateHostname(url.hostname)) {
        throw new UpstreamError(`Private network target is not allowed: ${url.hostname}`)
    }
}

export function matchAllowedHost(url: URL, pattern: string): boolean {
    const rule = pattern.trim().toLowerCase()
    if (!rule) {
        return false
    }
    const hostname = url.hostname.toLowerCase()
    if (rule.startsWith('*.')) {
        const suffix = rule.slice(2)
        // 同时匹配子域与主域
        return hostname === suffix || hostname.endsWith(`.${suffix}`)
    }
    if (rule.includes(':') && !rule.includes(']')) {
        // 带端口的规则，必须精确匹配 host
        return url.host.toLowerCase() === rule
    }
    return hostname === rule
}

export function isPrivateHostname(hostname: string): boolean {
    let host = hostname.toLowerCase()
    if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1)
    }
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true
    }
    if (host.includes(':')) {
        // IPv6 字面量
        if (host === '::1' || host === '::') {
            return true
        }
        if (/^f[cd][0-9a-f]{2}:/.test(host)) { // fc00::/7
            return true
        }
        if (/^fe[89ab][0-9a-f]?:/.test(host)) { // fe80::/10
            return true
        }
        const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
        if (mapped) {
            return isPrivateHostname(mapped[1])
        }
        return false
    }

    const ip = parseIPv4(host)
    if (!ip) {
        // 域名不做解析，DNS 层面的重绑定不在本函数覆盖范围内
        return false
    }
    const [a, b] = ip
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 100 && b >= 64 && b <= 127)
        || a >= 224
}

function parseIPv4(host: string): number[] | null {
    const parts = host.split('.')
    if (parts.length !== 4) {
        return null
    }
    const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
    if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) {
        return null
    }
    return nums
}

export async function requestUpstream(target: URL, options: UpstreamOptions = {}): Promise<UpstreamResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let current = new URL(target.toString())
    let sendToken = Boolean(options.token)
    let redirects = 0

    try {
        for (;;) {
            assertAllowedTarget(current, options.allowedHosts, options.blockPrivateNetwork)

            let response: Response
            try {
                response = await fetch(current, {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        'Accept-Encoding': 'identity',
                        ...(sendToken && options.token ? { Authorization: `Bearer ${options.token}` } : {}),
                    },
                    redirect: 'manual',
                    signal: controller.signal,
                })
            } catch (error) {
                if (controller.signal.aborted) {
                    throw new UpstreamError('Upstream request timed out')
                }
                throw new UpstreamError(`Request failed: ${(error as Error).message}`)
            }

            if (REDIRECT_STATUS.has(response.status)) {
                const location = response.headers.get('location')
                await response.body?.cancel().catch(() => undefined)
                if (!location) {
                    throw new UpstreamError(`Upstream returned ${response.status} without Location`)
                }
                if (redirects >= maxRedirects) {
                    throw new UpstreamError('Too many redirects')
                }
                redirects += 1
                const next = new URL(location, current)
                if (next.host !== current.host) {
                    // 与 fetch 行为保持一致：跨主机重定向不转发凭据
                    sendToken = false
                }
                current = next
                continue
            }

            const text = await readBody(response, maxBytes)
            return { status: response.status, ok: response.ok, text }
        }
    } finally {
        clearTimeout(timer)
    }
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) {
        return ''
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            total += value.byteLength
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined)
                throw new UpstreamError(`Upstream response exceeds ${maxBytes} bytes`)
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(merged)
}
