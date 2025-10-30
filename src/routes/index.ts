import { Hono } from 'hono'
import { Bindings } from '../types'
import logger from '@/middlewares/logger'

const app = new Hono<{ Bindings: Bindings }>()

type RequestData = {
    baseUrl: string
    token: string
}

app.on(['GET', 'POST'], '/status_forward', async (c) => {
    let data: RequestData = {} as RequestData
    if (c.req.method === 'GET') {
        data.baseUrl = c.req.query('baseUrl')
        data.token = c.req.query('token')
    } else if (c.req.method === 'POST') {
        data = await c.req.json() as RequestData
    }
    const { baseUrl, token } = data
    if (!baseUrl || !token) {
        return c.json({ action: 'error', message: 'Missing baseUrl or token' })
    }
    const url = new URL(baseUrl)
    url.pathname = '/get_status'
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: null,
        })
        if (response.ok) {
            const respData = await response.json()
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
        return c.json({ action: 'error', message: `Failed with status ${response.status}` }, 400)

    } catch (error) {
        console.error(error)
        return c.json({ action: 'error', message: 'Request failed' }, 400)
    }
})

export default app
