# Hydro API proxy (for the GitHub Pages / static deploy)

`api.meteo.lt` doesn't send CORS headers, so a browser blocks the dashboard's
JS from fetching it directly once the dashboard is static-hosted (GitHub
Pages can't run `serve_dashboard.py`'s Python proxy). This is a small
Cloudflare Worker that does the same proxying job instead — it's free, has
no server to maintain, and works for every visitor.

## Deploy it (~5 minutes, no command line needed)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and sign up for
   a free account (no credit card required for the free plan).
2. In the sidebar, go to **Workers & Pages** → **Create** → **Create Worker**.
3. Give it any name (e.g. `lithuania-dashboard-hydro-proxy`) and click **Deploy**
   to create it with the default "Hello World" code first.
4. Click **Edit code**, delete everything in the editor, and paste in the
   contents of [`hydro-proxy.js`](hydro-proxy.js) from this folder.
5. Click **Deploy** again.
6. Cloudflare gives you a URL like
   `https://lithuania-dashboard-hydro-proxy.YOUR-SUBDOMAIN.workers.dev`.
   That's your proxy's base URL.

## Wire it into the dashboard

Open [`../app.js`](../app.js) and find the `WORKER_HYDRO_PROXY_URL` constant
near the top (search for it). Replace the placeholder with your own Worker's
URL plus `/api/hydro/`, e.g.:

```js
const WORKER_HYDRO_PROXY_URL = "https://lithuania-dashboard-hydro-proxy.YOUR-SUBDOMAIN.workers.dev/api/hydro/";
```

Commit that change and push. The dashboard already auto-detects local dev
(`localhost`/`127.0.0.1`) and keeps using `serve_dashboard.py`'s own proxy
there — this URL is only used once the page is actually deployed somewhere
else (GitHub Pages, or anywhere that isn't localhost).

## Alternative: the `wrangler` CLI

If you'd rather deploy from a terminal instead of the dashboard UI:

```bash
npm install -g wrangler
wrangler login
cd cloudflare-worker
wrangler deploy
```

`wrangler deploy` prints the same `*.workers.dev` URL as step 6 above.

## Verify it worked

Once deployed, open (in a browser, or `curl`):

```
https://YOUR-WORKER-URL/api/hydro/hydro-stations
```

You should get back a JSON list of hydro stations, the same as
`https://api.meteo.lt/v1/hydro-stations` itself — just with an
`Access-Control-Allow-Origin` header added, which is the whole point.

## Free tier limits

100,000 requests/day, which is far more than a public dashboard like this
one is likely to see. If you ever exceed it, Cloudflare's paid tier is
$5/month for 10M requests — but the free tier should be enough indefinitely
for normal traffic.
