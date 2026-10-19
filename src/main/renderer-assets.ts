import { net, protocol, session } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

export function registerRendererAssets(options: {
  rendererRoot: string
  rendererDevUrl: string | null
  isRendererOrigin: (url: URL) => boolean
}): void {
  protocol.handle('app', (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    if (!options.isRendererOrigin(url)) return new Response('Forbidden', { status: 403 })
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
    const filePath = normalize(join(options.rendererRoot, rel))
    if (
      filePath !== options.rendererRoot &&
      !filePath.startsWith(`${options.rendererRoot}${sep}`)
    ) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })

  if (options.rendererDevUrl) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let url: URL | null
    try {
      url = new URL(details.url)
    } catch {
      url = null
    }
    if (!url || !options.isRendererOrigin(url)) {
      callback({ responseHeaders: details.responseHeaders ?? {} })
      return
    }
    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        'Content-Security-Policy': [CSP_POLICY]
      }
    })
  })
}
