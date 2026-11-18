// Node port of the Cloudflare Worker proxy.
// Runs on any Node host (Render, Railway, a VPS...). Start with: npm start
//
// Environment variables:
//   PORT           port to listen on (Render and Railway set this for you)
//   ALLOW_PRIVATE  set to "1" to allow private/local addresses (testing only)

import http from 'node:http';
import dns from 'node:dns';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as cheerio from 'cheerio';
import { Agent, fetch } from 'undici';
import { WebSocket, WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 10 * 1024 * 1024; // biggest body we will buffer or accept
const JS_REWRITE_LIMIT = 4 * 1024 * 1024; // JS files bigger than this pass through untouched
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 12000;
const PROXY = '/api/proxy?url='; // every proxied link is rewritten to start with this

// Static assets that used to be inlined in the worker file.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const CSS = read('search.css');
const LOGO = read('logo-uri.txt').trim();
// client-shim.js is "(function (B) { ... });". The trailing ";" is dropped so
// the page URL can be appended as the call argument: "(function (B) {...})(url)".
const CLIENT_SHIM = read('client-shim.js').trim().replace(/;$/, '');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const decodeUtf8 = bytes => new TextDecoder('utf-8').decode(bytes);

// Escape text for safe use inside HTML.
const esc = s =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// Turn HTML entities (&amp; &#39; ...) back into characters.
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const e = entity.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'nbsp') return ' ';
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

// Remove HTML tags and collapse whitespace.
const stripTags = s =>
  decodeEntities(String(s).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

// Decode a response body using the charset from the Content-Type header,
// or from a <meta charset> tag near the top of the page.
function decodeBody(buf, contentType) {
  let charset = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '') || [])[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 2048));
    const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i);
    charset = meta && meta[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return decodeUtf8(buf);
  }
}

// An Error that carries an HTTP status code.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Safety: block requests to private / internal addresses (SSRF protection)
// ---------------------------------------------------------------------------

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  // Names that only make sense inside a network. A name with no dot at all
  // (like "redis" or "my-service") is almost always an internal service on
  // hosts such as Render and Railway.
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (!h.includes('.') && !h.includes(':')) return true;

  // Numeric tricks like http://2130706433 or http://0x7f000001
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;

  // IPv4
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = +v4[1];
    const b = +v4[2];
    return (
      a === 10 || // 10.0.0.0/8
      a === 127 || // loopback
      a === 0 ||
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 198 && (b === 18 || b === 19)) || // benchmarking range
      a >= 224 // multicast and reserved
    );
  }

  // IPv6
  if (h.includes(':')) {
    if (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    if (h.startsWith('::ffff:')) return true; // IPv4-mapped addresses
  }
  return false;
}

// Used for every outgoing connection. It checks the IP address a hostname
// actually resolves to, so a public-looking name that points at an internal
// address (DNS rebinding) is refused too. The Worker did not need this because
// Cloudflare cannot reach private networks; a Node server can.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!ALLOW_PRIVATE && list.some(entry => isPrivateHost(entry.address))) {
      return callback(new Error('That address is not allowed.'));
    }
    callback(null, address, family);
  });
}

const agent = new Agent({ connect: { lookup: safeLookup } });

// Validate a URL before fetching it. Returns the parsed URL.
function checkTarget(raw, selfHost) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, 'That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'Only http and https URLs are supported.');
  }
  if (!ALLOW_PRIVATE && isPrivateHost(url.hostname)) throw httpError(403, 'That address is not allowed.');
  if (selfHost && url.hostname.toLowerCase() === selfHost) throw httpError(403, 'The proxy cannot fetch itself.');
  return url;
}

// ---------------------------------------------------------------------------
// Fetching other sites
// ---------------------------------------------------------------------------

// Pick a Referer header that looks natural to the target site.
function refererFor(url, referrer) {
  if (!referrer) return url.origin + '/';
  try {
    const r = new URL(referrer);
    return r.origin === url.origin ? r.href : r.origin + '/';
  } catch {
    return url.origin + '/';
  }
}

// fetch() that follows redirects by hand so every hop goes through checkTarget.
async function fetchFollow(startUrl, init = {}) {
  let url = startUrl;
  let method = init.method || 'GET';
  let body = init.body;
  const extraHeaders = { ...(init.headers || {}) };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = checkTarget(url, init.selfHost);
    const headers = {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'identity',
      ...extraHeaders,
      referer: refererFor(target, init.referrer),
    };
    if (method !== 'GET' && method !== 'HEAD') headers.origin = target.origin;

    let res;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(target.href, {
        method,
        body,
        redirect: 'manual',
        signal: abort.signal,
        headers,
        dispatcher: agent,
      });
    } catch (e) {
      const cause = e && e.cause;
      if (cause && cause.message === 'That address is not allowed.') throw httpError(403, 'That address is not allowed.');
      const reason = e && e.name === 'AbortError' ? 'timed out' : 'connection failed';
      throw httpError(504, 'Could not reach ' + target.hostname + ' (' + reason + ').');
    } finally {
      clearTimeout(timer);
    }

    const location = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      let next;
      try {
        next = new URL(location, target);
      } catch {
        throw httpError(502, 'The site sent an invalid redirect.');
      }
      try {
        await res.body?.cancel();
      } catch {}

      // 303 (and 301/302 after a POST) turn into a GET without a body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        if (method !== 'HEAD') method = 'GET';
        body = undefined;
        delete extraHeaders['content-type'];
      }
      // Never leak credentials to a different site.
      if (next.origin !== target.origin) delete extraHeaders.authorization;

      url = next.href;
      continue;
    }
    return { res, url: target.href };
  }
  throw httpError(508, 'Too many redirects.');
}

// Read a whole upstream response into memory, enforcing the size limit.
async function readBody(res) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw httpError(413, 'That file is too large to proxy (limit 10 MB).');
  let buf;
  try {
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    throw httpError(504, 'The connection dropped while downloading.');
  }
  if (buf.length > MAX_BYTES) throw httpError(413, 'That file is too large to proxy (limit 10 MB).');
  return buf;
}

// Request headers we do NOT pass on to the target site.
const DROP_REQUEST_HEADERS =
  /^(host|connection|content-length|cookie|origin|referer|user-agent|accept-encoding|te|upgrade|upgrade-insecure-requests|transfer-encoding|keep-alive|via|forwarded|priority|dnt|proxy-.*|cf-.*|x-forwarded-.*|x-real-ip|true-client-ip|sec-.*|x-render-.*|x-railway-.*|rndr-.*)$/i;

// Node already gives header names in lower case; values may be arrays.
function forwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (DROP_REQUEST_HEADERS.test(name)) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

// When the browser loads a sub-resource, its Referer is our own proxy URL.
// This pulls the real page URL back out of it.
function realUrlFromReferer(req, reqUrl) {
  try {
    const ref = new URL(req.headers.referer || '');
    if (ref.host !== reqUrl.host || ref.pathname !== '/api/proxy') return null;
    const real = ref.searchParams.get('url');
    return real ? new URL(real).href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// YouTube: show a clean embedded player instead of proxying the whole site
// ---------------------------------------------------------------------------

function parseYouTube(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  let id = null;

  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) id = m[2];
    }
  }
  if (!id || !/^[\w-]{6,20}$/.test(id)) return null;

  return {
    id,
    list: url.searchParams.get('list'),
    start: url.searchParams.get('t') || url.searchParams.get('start'),
  };
}

function youTubePage(video) {
  const query = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1', modestbranding: '1' });
  if (video.list && !/^RD/.test(video.list)) query.set('list', video.list); // skip auto-generated mixes
  const start = parseInt(video.start, 10);
  if (start > 0) query.set('start', String(start));

  return (
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube</title>' +
    '<style>html,body{height:100%;margin:0;background:#000}' +
    'iframe{position:absolute;inset:0;width:100%;height:100%;border:0}</style>' +
    '<iframe src="https://www.youtube-nocookie.com/embed/' + video.id + '?' + query.toString() + '"' +
    ' allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"' +
    ' allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>'
  );
}

// ---------------------------------------------------------------------------
// WebSockets: browser <-> this server <-> target site
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({
  noServer: true,
  // Reply with whichever sub-protocol the target site accepted.
  handleProtocols: (protocols, request) => request.chosenProtocol || false,
});

// Close codes that are legal to send in a close frame.
const validCloseCode = c => c >= 1000 && c <= 4999 && ![1004, 1005, 1006, 1015].includes(c);

// Forward messages and closes from one socket to the other.
function relay(from, to) {
  from.on('message', (data, isBinary) => {
    try {
      to.send(data, { binary: isBinary });
    } catch {}
  });
  from.on('close', (code, reason) => {
    try {
      to.close(validCloseCode(code) ? code : 1000, reason);
    } catch {}
  });
  from.on('error', () => {
    try {
      to.close(1011, 'error');
    } catch {}
  });
}

function rejectUpgrade(socket, status, message) {
  socket.write(
    'HTTP/1.1 ' + status + ' ' + (http.STATUS_CODES[status] || 'Error') + '\r\n' +
      'Connection: close\r\nContent-Type: text/plain\r\nContent-Length: ' + Buffer.byteLength(message) +
      '\r\n\r\n' + message
  );
  socket.destroy();
}

function handleUpgrade(req, socket, head) {
  let target;
  try {
    const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    target = (reqUrl.searchParams.get('url') || '').trim();
    if (reqUrl.pathname !== '/api/proxy' || !target) return rejectUpgrade(socket, 404, 'Nothing here.');

    // The page may ask for ws:// or wss://; checkTarget wants http(s).
    const wsUrl = new URL(target);
    if (wsUrl.protocol === 'http:') wsUrl.protocol = 'ws:';
    if (wsUrl.protocol === 'https:') wsUrl.protocol = 'wss:';
    const asHttp = new URL(wsUrl.href);
    asHttp.protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
    checkTarget(asHttp.href, (req.headers.host || '').split(':')[0].toLowerCase());

    const requested = (req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    const upstream = new WebSocket(wsUrl.href, requested, {
      headers: { 'user-agent': UA },
      origin: asHttp.origin,
      lookup: safeLookup,
      handshakeTimeout: FETCH_TIMEOUT_MS,
    });

    upstream.on('error', () => rejectUpgrade(socket, 502, 'The site refused the WebSocket connection.'));
    upstream.on('open', () => {
      req.chosenProtocol = upstream.protocol || null;
      wss.handleUpgrade(req, socket, head, client => {
        relay(client, upstream);
        relay(upstream, client);
      });
    });
  } catch (e) {
    rejectUpgrade(socket, (e && e.status) || 400, (e && e.message) || 'Bad request.');
  }
}

// ---------------------------------------------------------------------------
// Search (Bing, DuckDuckGo "Venom" engine, Wikipedia)
// ---------------------------------------------------------------------------

function parseDuckDuckGo(html) {
  const results = [];
  const linkTag = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = linkTag.exec(html))) starts.push({ tag: m[0], index: m.index, end: m.index + m[0].length });

  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const chunkEnd = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const closeIdx = html.indexOf('</a>', s.end);
    const title = stripTags(html.slice(s.end, closeIdx < 0 ? s.end : closeIdx));
    const hrefMatch = s.tag.match(/href="([^"]*)"/i);
    if (!hrefMatch || !title) continue;

    let href = decodeEntities(hrefMatch[1]);
    try {
      // DuckDuckGo wraps real links in a redirect with the target in "uddg".
      const wrapped = new URL(href, 'https://duckduckgo.com');
      href = wrapped.searchParams.get('uddg') || wrapped.href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // skip ads

    const rest = html.slice(s.end, chunkEnd);
    const snippet = rest.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    results.push({ t: title, u: href, s: snippet ? stripTags(snippet[1]) : '' });
  }
  return results;
}

function parseBing(html) {
  const results = [];
  const blocks = html.split(/<li class="b_algo\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;

    let href = decodeEntities(a[1]);
    // Bing hides the real URL as base64 in the "u" parameter (prefixed "a1").
    const encoded = href.match(/[?&]u=a1([^&]+)/);
    if (encoded) {
      try {
        const bin = atob(encoded[1].replace(/-/g, '+').replace(/_/g, '/'));
        href = decodeUtf8(Uint8Array.from(bin, c => c.charCodeAt(0)));
      } catch {}
    }
    if (!/^https?:\/\//i.test(href)) continue;

    const para = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ t: stripTags(a[2]), u: href, s: para ? stripTags(para[1]) : '' });
  }
  return results;
}

async function wikipediaSearch(query) {
  let res;
  try {
    res = await fetch(
      'https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=10&format=json&srsearch=' +
        encodeURIComponent(query),
      { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) }
    );
  } catch {
    throw httpError(504, 'Could not reach Wikipedia.');
  }
  if (!res.ok) throw httpError(502, 'Wikipedia answered ' + res.status + '.');

  let json;
  try {
    json = await res.json();
  } catch {
    throw httpError(502, 'Wikipedia sent an unreadable answer.');
  }
  return ((json.query && json.query.search) || []).map(item => ({
    t: item.title,
    u: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(item.title.replace(/ /g, '_')),
    s: stripTags(item.snippet),
  }));
}

// Returns { label, results }. Falls back to Wikipedia if the web search fails.
async function runSearch(query, engine) {
  const enc = encodeURIComponent;
  if (engine === 'wikipedia') return { label: 'Wikipedia', results: await wikipediaSearch(query) };

  try {
    if (engine === 'bing') {
      const { res } = await fetchFollow('https://www.bing.com/search?q=' + enc(query) + '&setlang=en');
      const results = parseBing(decodeBody(await readBody(res), res.headers.get('content-type')));
      if (results.length) return { label: 'Bing', results };
    } else {
      const { res } = await fetchFollow('https://html.duckduckgo.com/html/?q=' + enc(query));
      const results = parseDuckDuckGo(decodeBody(await readBody(res), res.headers.get('content-type')));
      if (results.length) return { label: 'Venom', results };
    }
  } catch {}

  return { label: 'Wikipedia (web search was unavailable)', results: await wikipediaSearch(query) };
}

// ---------------------------------------------------------------------------
// HTML pages the server generates itself
// ---------------------------------------------------------------------------

function searchPage(query, engine, label, results, noteHtml) {
  const items = results
    .map(
      r =>
        '<li><a class="t" href="' + PROXY + encodeURIComponent(r.u) + '">' + esc(r.t) + '</a>' +
        '<div class="u">' + esc(r.u.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 90)) + '</div>' +
        (r.s ? '<p>' + esc(r.s) + '</p>' : '') +
        '</li>'
    )
    .join('');

  const body = results.length
    ? '<ul>' + items + '</ul>'
    : query
      ? '<p class="note">No results for “' + esc(query) + '”.</p>'
      : noteHtml || '';

  return (
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    '<title>' + esc(query || 'Search') + ' – Venom</title><style>' + CSS + '</style>' +
    '<header><span class="lg"><img src="' + LOGO + '" alt=""><b>Venom</b></span>' +
    '<form action="/api/proxy" method="get">' +
    '<input name="q" value="' + esc(query) + '" autocomplete="off" aria-label="Search">' +
    '<select name="engine" aria-label="Engine">' +
    '<option value="bing" selected>Bing</option><option value="venom">Venom</option><option value="wikipedia">Wikipedia</option>' +
    '</select><button type="submit">Search</button></form></header>' +
    '<main><h2>' + esc(label) + '</h2>' + body + '</main>'
  );
}

function messagePage(title, message) {
  return (
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><title>Venom</title>' +
    '<style>' + CSS + 'body{display:grid;place-content:center;min-height:100vh;text-align:center;padding:24px}</style>' +
    '<h1 style="margin:0 0 8px">' + esc(title) + '</h1><p class="note">' + esc(message) + '</p>'
  );
}

// ---------------------------------------------------------------------------
// Rewriting pages so every link, script and image goes back through the proxy
// ---------------------------------------------------------------------------

// Turn one URL (absolute or relative) into a proxied URL.
function proxify(value, base) {
  const s = String(value).trim();
  if (!s || s[0] === '#' || /^(?:data|blob|javascript|mailto|tel|about):/i.test(s)) return value;
  try {
    const url = new URL(s, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
    const hash = url.hash;
    url.hash = '';
    return PROXY + encodeURIComponent(url.href) + hash;
  } catch {
    return value;
  }
}

// srcset looks like "a.jpg 1x, b.jpg 2x"
function proxifySrcset(srcset, base) {
  return String(srcset)
    .split(/\s*,\s+/)
    .filter(Boolean)
    .map(candidate => {
      const parts = candidate.trim().split(/\s+/);
      parts[0] = proxify(parts[0], base);
      return parts.join(' ');
    })
    .join(', ');
}

function rewriteCss(css, base) {
  return css
    .replace(/(@import\s+)(["'])([^"'\n]+)\2/gi, (m, prefix, quote, url) => prefix + quote + proxify(url, base) + quote)
    .replace(/url\(\s*(?:(["'])(.*?)\1|([^)"'\s][^)]*?))\s*\)/gi, (match, quote, quoted, bare) => {
      const url = (quoted !== undefined ? quoted : bare).trim();
      const proxied = proxify(url, base);
      return proxied === url ? match : 'url("' + proxied + '")';
    });
}

// Only touches ES module import/export paths; other JS is left alone.
function rewriteJs(js, base) {
  if (!/\b(?:import|export)\b/.test(js)) return js;
  const fix = s => (/^(?:\.{0,2}\/|https?:\/\/)/.test(s) ? proxify(s, base) : s);
  const sub = (m, prefix, quote, spec) => prefix + quote + fix(spec) + quote;
  return js
    .replace(/(\b(?:import|export)\b[^'"`;()=]*?\bfrom\s*)(["'])([^"'\n]+)\2/g, sub) // import x from "..."
    .replace(/(\bimport\s*)(["'])([^"'\n]+)\2/g, sub) // import "..."
    .replace(/(\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g, sub); // import("...")
}

// Which attribute holds the URL, per element type.
const URL_ATTRIBUTES = [
  ['a[href], area[href], link[href]', 'href'],
  ['script[src], img[src], source[src], video[src], audio[src], track[src], embed[src], iframe[src], frame[src], input[src]', 'src'],
  ['video[poster]', 'poster'],
  ['object[data]', 'data'],
];

function rewriteHtml(html, finalUrl) {
  const $ = cheerio.load(html);

  // <base href> changes how relative URLs resolve. Use it, then remove it.
  let base = finalUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    try {
      base = new URL(baseHref, finalUrl).href;
    } catch {}
  }
  $('base').remove();

  // Strip tags that would block the proxied page from running.
  $('meta[name="referrer"]').remove();
  $('meta[http-equiv]').each((i, el) => {
    const equiv = ($(el).attr('http-equiv') || '').toLowerCase();
    if (['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'refresh'].includes(equiv)) {
      $(el).remove();
    }
  });
  $('link[integrity], script[integrity]').removeAttr('integrity'); // rewritten files no longer match the hash

  // Rewrite URLs in attributes.
  for (const [selector, attr] of URL_ATTRIBUTES) {
    $(selector).each((i, el) => {
      const value = $(el).attr(attr);
      if (value != null) $(el).attr(attr, proxify(value, base));
    });
  }
  $('[srcset]').each((i, el) => {
    $(el).attr('srcset', proxifySrcset($(el).attr('srcset'), base));
  });
  $('[style]').each((i, el) => {
    const style = $(el).attr('style');
    if (style && style.includes('url(')) $(el).attr('style', rewriteCss(style, base));
  });

  // Rewrite <style> blocks and inline scripts.
  $('style').each((i, el) => {
    $(el).text(rewriteCss($(el).text(), base));
  });
  $('script:not([src])').each((i, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!type || /module|javascript|ecmascript/.test(type)) $(el).text(rewriteJs($(el).text(), base));
  });

  // Inject the client-side shim at the very top of <head>, so it runs before
  // any of the page's own scripts.
  const shim =
    '<meta name="referrer" content="same-origin">' +
    '<script>' + CLIENT_SHIM + '(' + JSON.stringify(finalUrl).replace(/</g, '\\u003c') + ')</script>';
  $('head').prepend(shim);

  return $.html();
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Send a response with CORS headers attached.
function send(req, res, status, headers, body) {
  const origin = req.headers.origin;
  const out = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Expose-Headers': 'x-final-url, content-type, content-range, accept-ranges, content-disposition',
  };
  if (origin) {
    out['Access-Control-Allow-Credentials'] = 'true';
    out['Vary'] = 'Origin';
  }
  Object.assign(out, headers);

  const noBody = [204, 205, 304].includes(status) || req.method === 'HEAD';
  res.writeHead(status, out);

  if (noBody || body == null) return res.end();
  if (body instanceof Readable) {
    res.on('close', () => body.destroy()); // stop downloading if the browser goes away
    body.on('error', () => res.destroy());
    return body.pipe(res);
  }
  res.end(body);
}

// Read the request body, refusing anything over the size limit.
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(httpError(413, 'That request is too large to proxy (limit 10 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const HTML_UTF8 = 'text/html; charset=utf-8';

async function handleRequest(req, res) {
  const reply = (status, headers, body) => send(req, res, status, headers, body);

  try {
    const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const selfHost = reqUrl.hostname.toLowerCase();
    const params = reqUrl.searchParams;
    const target = (params.get('url') || '').trim();

    if (req.method === 'OPTIONS') return reply(204, {}, null);
    if (reqUrl.pathname === '/healthz') return reply(200, { 'content-type': 'text/plain' }, 'ok');

    // A proxied page asked for a root-relative file (like /style.css) that
    // slipped past the rewriting. Redirect it to the same path on the real site.
    if (reqUrl.pathname !== '/api/proxy' && !params.has('url')) {
      const real = realUrlFromReferer(req, reqUrl);
      if (real) {
        try {
          const fixed = new URL(reqUrl.pathname + reqUrl.search, real).href;
          return reply(307, { location: PROXY + encodeURIComponent(fixed), 'cache-control': 'no-store' }, null);
        } catch {}
      }
    }

    if (!ALLOWED_METHODS.includes(req.method)) return reply(405, { 'content-type': 'text/plain' }, 'Method not allowed');

    // Search box
    const query = (params.get('q') || '').trim().slice(0, 300);
    if (query) {
      const requested = String(params.get('engine') || '').toLowerCase();
      const engine = requested === 'wikipedia' ? 'wikipedia' : requested === 'venom' || requested === 'paradox' ? 'venom' : 'bing';
      const { label, results } = await runSearch(query, engine);
      return reply(200, { 'content-type': HTML_UTF8, 'cache-control': 'public, max-age=300' }, searchPage(query, engine, label, results));
    }

    // Home page
    if (!target && reqUrl.pathname !== '/api/proxy' && reqUrl.pathname !== '/') throw httpError(404, 'Nothing here.');
    if (!target) {
      const note = '<p class="note">Venom server is running. Type a search above, or call /api/proxy?url=https://example.com</p>';
      return reply(200, { 'content-type': HTML_UTF8 }, searchPage('', 'bing', 'Search', [], note));
    }

    // YouTube links get the embed player (add &raw=1 to skip this)
    if (req.method === 'GET' && params.get('raw') !== '1') {
      const video = parseYouTube(target);
      if (video) return reply(200, { 'content-type': HTML_UTF8, 'cache-control': 'no-store' }, youTubePage(video));
    }

    // Fetch the real page
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let body;
    if (hasBody) {
      const data = await readRequestBody(req);
      if (data.length) body = data;
    }
    const { res: upstream, url: finalUrl } = await fetchFollow(target, {
      method: req.method,
      body,
      headers: forwardHeaders(req.headers),
      referrer: realUrlFromReferer(req, reqUrl),
      selfHost,
    });

    // Google blocks datacenter IPs with a "sorry" page; say so instead of showing it.
    const finalHost = new URL(finalUrl);
    if (/(^|\.)google\.[a-z.]+$/i.test(finalHost.hostname) && /^\/sorry\//.test(finalHost.pathname)) {
      throw httpError(429, 'Google is rejecting this server with an unusual-traffic check, so this page cannot be loaded through it.');
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const cacheControl = upstream.headers.get('cache-control') || '';
    const cache =
      hasBody || !upstream.ok || /no-store|no-cache|private/i.test(cacheControl) ? 'no-store' : 'public, max-age=300';
    const baseHeaders = extra => Object.assign({ 'x-final-url': finalUrl, 'cache-control': cache }, extra);

    const raw = params.get('raw') === '1';
    const isHtml = /text\/html|application\/xhtml/i.test(contentType);
    const isCss = /text\/css/i.test(contentType);
    const isJs = /javascript|ecmascript/i.test(contentType);

    // HTML, CSS and JS are rewritten; everything else streams straight through.
    if (!raw && (isHtml || isCss || isJs)) {
      const buf = await readBody(upstream);
      const status = upstream.status === 206 ? 200 : upstream.status;
      if (isHtml) return reply(status, baseHeaders({ 'content-type': HTML_UTF8 }), rewriteHtml(decodeBody(buf, contentType), finalUrl));
      if (isCss) return reply(status, baseHeaders({ 'content-type': 'text/css; charset=utf-8' }), rewriteCss(decodeBody(buf, contentType), finalUrl));
      if (buf.length <= JS_REWRITE_LIMIT) {
        return reply(status, baseHeaders({ 'content-type': 'text/javascript; charset=utf-8' }), rewriteJs(decodeBody(buf, contentType), finalUrl));
      }
      return reply(status, baseHeaders({ 'content-type': contentType }), Buffer.from(buf));
    }

    const passThrough = { 'content-type': contentType };
    for (const name of ['content-range', 'accept-ranges', 'content-disposition']) {
      const value = upstream.headers.get(name);
      if (value) passThrough[name] = value;
    }
    const stream = upstream.body ? Readable.fromWeb(upstream.body) : null;
    return reply(upstream.status, baseHeaders(passThrough), stream);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    const status = e && e.status ? e.status : 500;
    reply(status, { 'content-type': HTML_UTF8, 'cache-control': 'no-store' }, messagePage('Error ' + status, (e && e.message) || 'Something went wrong.'));
  }
}

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);
server.headersTimeout = 20000;

server.listen(PORT, () => {
  console.log('Proxy listening on port ' + PORT + (ALLOW_PRIVATE ? ' (private addresses allowed)' : ''));
});

// A single bad request should never take the whole server down.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));
