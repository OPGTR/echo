const http = require('http')
const https = require('https')
const dns = require('dns').promises
const net = require('net')
const { CookieJar } = require('tough-cookie')

const REDIRECTS = new Set([301, 302, 303, 307, 308])
// Addresses an extension may not reach: the phone itself, the local network,
// and the IPv6 forms that hide an IPv4 one (::ffff:7f00:1 is 127.0.0.1).
const V4 = new net.BlockList(), V6 = new net.BlockList()
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) V4.addSubnet(a, n, 'ipv4')
for (const [a, n] of [['::1', 128], ['::', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32]]) V6.addSubnet(a, n, 'ipv6')
/** The IPv4 address an IPv6 one carries (::ffff:a.b.c.d, ::a.b.c.d, NAT64 64:ff9b::/96), if any. */
function embeddedV4(v6) {
  const words = expand(v6)
  if (!words) return null
  const head = words.slice(0, 6).map(w => w.toString(16)).join(':')
  const tail = words.slice(6)
  const v4 = () => `${tail[0] >> 8}.${tail[0] & 255}.${tail[1] >> 8}.${tail[1] & 255}`
  if (head === '0:0:0:0:0:ffff' || head === '0:0:0:0:0:0' || head === '64:ff9b:0:0:0:0') return v4()
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return v4() // 64:ff9b:1::/48 (local NAT64)
  return null
}
function expand(v6) {
  let text = v6
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) { const p = dotted[1].split('.').map(Number); text = text.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16) }
  const [l, r] = text.split('::')
  const left = l ? l.split(':') : [], right = r !== undefined && r ? r.split(':') : []
  const fill = r !== undefined ? Array(8 - left.length - right.length).fill('0') : []
  const all = [...left, ...fill, ...right]
  return all.length === 8 ? all.map(x => parseInt(x || '0', 16)) : null
}
function privateAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (net.isIPv4(value)) return V4.check(value, 'ipv4')
  if (!net.isIPv6(value)) return true
  const v4 = embeddedV4(value)
  if (v4) return V4.check(v4, 'ipv4') || (value.startsWith('::') && !value.startsWith('::ffff:') && v4 === '0.0.0.0')
  return V6.check(value, 'ipv6')
}
function domainAllowed(host, domains) {
  return domains.some(domain => domain.startsWith('*.') ? host.endsWith(domain.slice(1)) && host !== domain.slice(2) : host === domain.toLowerCase())
}
function validateURL(raw, permissions) {
  const url = new URL(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.username || url.password || !domainAllowed(host, permissions.network || [])) throw new Error(`Network permission denied for ${host}`)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && permissions.allowHttp)) throw new Error('This addon requires HTTPS')
  return url
}
class ExtensionNetwork {
  constructor(permissions) { this.permissions = permissions; this.cookies = new CookieJar() }
  async request(raw, { method = 'GET', body, headers = {}, signal, directMedia = false, stallMs = 30000 } = {}) {
    let url = validateURL(raw, this.permissions)
    headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(host|content-length|connection|transfer-encoding|proxy-authorization)$/i.test(k)).map(([k,v]) => [k, String(v)]))
    for (let hop = 0; hop <= 5; hop++) {
      signal?.throwIfAborted()
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true })
      const explicitLocal = (this.permissions.network || []).some(d => d === host) && (host === 'localhost' || net.isIP(host) && privateAddress(host))
      if (!addresses.length || !explicitLocal && addresses.some(a => privateAddress(a.address))) throw new Error('Addon request resolved to a private address without explicit permission')
      const cookie = directMedia ? '' : this.cookies.getCookieStringSync(url.href)
      const requestHeaders = { 'User-Agent': 'Mornye-Extension/1.0', ...headers } // Mornye's default for extension requests
      if (cookie && !Object.keys(requestHeaders).some(k => k.toLowerCase() === 'cookie')) requestHeaders.Cookie = cookie
      const response = await new Promise((resolve, reject) => {
        const req = (url.protocol === 'https:' ? https : http).request(url, {
          method, headers: requestHeaders, signal,
          lookup: (_host, options, cb) => options?.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family),
        }, resolve)
        req.on('error', reject)
        req.setTimeout(stallMs, () => req.destroy(new Error('Addon network request stalled')))
        if (body && method !== 'GET' && method !== 'HEAD') req.write(body)
        req.end()
      })
      if (!directMedia && response.headers['set-cookie']?.length) {
        for (const cookie of response.headers['set-cookie']) { try { this.cookies.setCookieSync(cookie, url.href) } catch {} }
        this.persist?.()
      }
      const status = response.statusCode || 0
      if (REDIRECTS.has(status) && response.headers.location) {
        response.destroy()
        if (directMedia) throw new Error('Direct-media downloads do not follow redirects')
        const next = validateURL(new URL(response.headers.location, url).href, this.permissions)
        if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|x-.*(?:token|key|signature|session))$/i.test(k)))
        if (status === 303 || (status === 301 || status === 302) && method === 'POST') { method = 'GET'; body = undefined }
        url = next; continue
      }
      return { response, url: url.href, status, headers: response.headers }
    }
    throw new Error('Too many addon redirects')
  }
  async jsonResponse(url, options = {}) {
    const { response, status, headers, url: finalUrl } = await this.request(url, options)
    const chunks = []; let size = 0
    try {
      for await (const chunk of response) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) throw new Error('Addon network response exceeds 16 MB')
        chunks.push(chunk)
      }
    } finally { response.destroy() }
    const bytes = Buffer.concat(chunks)
    return { statusCode: status, status, ok: status >= 200 && status < 300, url: finalUrl, headers, body: bytes.toString(), ...(options.asFetch ? { binary: bytes.toString('base64') } : {}) }
  }
}
module.exports = { ExtensionNetwork, validateURL, domainAllowed, privateAddress }
