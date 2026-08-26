# Hosting the GRPK raster tiles

`rasters/grpk/` (8.46 GB, ~8,800 files) is deliberately not part of the git
repo — see the main [`README.md`](../README.md#data-not-included-in-this-repo)
for why. It needs to live somewhere with public HTTP access instead, and
`dashboard/app.js`'s `GRPK_RASTER_BASE_URL` constant needs to point at it.

This uses **Cloudflare R2** (S3-compatible object storage, 10 GB free
storage / month, no egress fees — egress is what would otherwise make
serving 8.46 GB to visitors expensive on most other providers). Any other
S3-compatible bucket (AWS S3, Backblaze B2, etc.) would work the same way
— just adjust the endpoint URL in the rclone config below.

## 1. Create the bucket

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2 Object Storage**
   → **Create bucket**. Name it anything (e.g. `lithuania-dashboard-grpk`).
2. Open the bucket → **Settings** → **Public Access** → enable the
   `r2.dev` subdomain (or attach your own custom domain if you have one).
   Note the public base URL it gives you, e.g.
   `https://pub-xxxxxxxx.r2.dev`.
3. Still in **Settings**, find **CORS Policy** and add:
   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET"],
       "AllowedHeaders": ["*"]
     }
   ]
   ```
   Without this, the browser will block the dashboard's `fetch()` calls to
   these tiles the same way it blocked api.meteo.lt before the hydro proxy
   existed — R2 needs to explicitly say "any origin can GET these."
4. Under **Manage R2 API Tokens**, create a token with **Object Read &
   Write** permission scoped to this bucket. Save the **Access Key ID**,
   **Secret Access Key**, and your **Account ID** (all shown once) — the
   upload step needs them.

## 2. Upload the tiles

Install [`rclone`](https://rclone.org/downloads/) (a single binary, no
dependencies), then configure it once:

```
rclone config
```
Pick `n` (new remote), name it `r2`, type `s3`, provider `Cloudflare`,
paste in the Access Key ID / Secret Access Key from step 1.4, and for the
endpoint use `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Leave the
rest as defaults.

Then sync the tiles (run from the repo root, i.e. this folder's parent):

```
rclone sync rasters/grpk r2:lithuania-dashboard-grpk --progress --transfers 16 --checkers 16
```

This is a real upload of 8.46 GB across ~8,800 files — expect it to take a
while depending on your connection (`--progress` shows a live ETA).
`rclone sync` is safe to re-run if it gets interrupted; it only
uploads what's missing/changed rather than starting over.

## 3. Wire it into the dashboard

Open `dashboard/app.js`, find `GRPK_RASTER_BASE_URL` near the top, and
replace the placeholder with your bucket's public base URL from step 1.2,
keeping the `/rasters/grpk/` suffix so the path structure matches what got
uploaded:

```js
const GRPK_RASTER_BASE_URL = "https://pub-xxxxxxxx.r2.dev/rasters/grpk/";
```

Wait — actually the path should match whatever prefix you synced *to*. If
you ran the `rclone sync` command above exactly as written (syncing
`rasters/grpk` to the bucket's root), the files sit at the bucket root, so
this constant should just be your bucket's public base URL with a trailing
slash and no `/rasters/grpk/` suffix, e.g. `https://pub-xxxxxxxx.r2.dev/`.
Verify with the check below before assuming either way.

## 4. Verify it worked

```
curl -I https://YOUR-PUBLIC-BUCKET-URL/tiles/manifest.json
```

(or whatever a real file's path looks like under `rasters/grpk/` locally —
match it 1:1 against what you uploaded to). You should get `200 OK` with
an `Access-Control-Allow-Origin: *` header. If you get `404`, the sync
path prefix doesn't match what `GRPK_RASTER_BASE_URL` expects — check
step 3's note above.

## Free tier limits

R2's free tier is 10 GB storage/month — 8.46 GB fits, but with not much
headroom if GRPK tiles grow (a new year's data, higher zoom levels, etc.).
Watch usage in the Cloudflare dashboard; the paid tier beyond free is
$0.015/GB-month, cheap even if you exceed it.
