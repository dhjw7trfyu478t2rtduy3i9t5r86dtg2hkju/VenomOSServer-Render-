# Venom proxy (Node version)

Node port of the Cloudflare Worker. Same routes and behavior:

- `/` home page with search box
- `/api/proxy?url=https://example.com` proxies a page (HTML, CSS, JS rewritten)
- `/api/proxy?q=cats&engine=bing|venom|wikipedia` search
- WebSockets, POST/PUT/PATCH/DELETE, and YouTube embed all work
- `/healthz` returns `ok` (handy for host health checks)

## Files

| File | What it is |
| --- | --- |
| `server.js` | The server, split into labelled sections |
| `client-shim.js` | Script injected into proxied pages (patches fetch, links, forms, WebSocket) |
| `search.css` | Styles for the search and error pages |
| `logo-uri.txt` | Logo as a data URI |

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Needs Node 20.18.1 or newer.

## Deploy on Render

1. Push this folder to a GitHub repo (do not commit `node_modules`).
2. Render dashboard: **New + > Web Service**, pick the repo.
3. Runtime **Node**, Build Command `npm install`, Start Command `npm start`.
4. Deploy. Render sets `PORT` for you.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. Railway: **New Project > Deploy from GitHub repo**.
3. Under **Settings > Networking**, click **Generate Domain**.
4. That is it. Railway detects Node and runs `npm start`.

## Environment variables

| Name | Meaning |
| --- | --- |
| `PORT` | Set by the host. Defaults to 3000 locally. |
| `ALLOW_PRIVATE` | `1` allows private/local addresses. Leave unset in production. |

## Differences from the Worker

- Uses `cheerio` instead of Cloudflare's `HTMLRewriter`, and `ws` for WebSockets.
- Hostnames are checked after DNS lookup, and names with no dot (like `redis`) are
  blocked, so the proxy cannot be pointed at your host's internal network.
- Free tiers sleep when idle (Render) or have limited hours (Railway), so the first
  request after a pause can be slow.
