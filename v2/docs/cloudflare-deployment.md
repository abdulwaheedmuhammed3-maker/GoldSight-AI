# Free website publishing — Cloudflare Workers Static Assets

TradeSight 2.0 is a new static single-page application. Use Cloudflare Workers Static Assets for public hosting. Do not use GitHub Pages for this trading platform: GitHub's Pages policy says it is not intended for websites primarily providing commercial software as a service.

## Cost model

- The static website bundle is served as static assets. Cloudflare documents static asset requests as free and unlimited.
- The current pipeline does not add Workers Functions, D1, KV, R2 or paid compute.
- A free Cloudflare account is sufficient for the static-only Worker, subject to current platform terms and limits.
- The Android APK build remains on GitHub Actions; standard hosted runners are free for public repositories.

Cloudflare can change plan limits and terms. Check the official [Workers Static Assets pricing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) and [Workers Free limits](https://developers.cloudflare.com/workers/platform/pricing/) before adding server-side features.

## One-time setup

A repository maintainer must create a Cloudflare API token and add it to GitHub. The connected Cloudflare dashboard session cannot be reused by a GitHub Actions runner.

1. In Cloudflare, open **My Profile → API Tokens → Create Token**.
2. Create a token restricted to the TradeSight Cloudflare account. Grant the Workers product-level **Admin** role needed to create the first Worker. After the first Worker exists, a separate deployment token can be narrowed to **Editor** for that Worker.
3. Copy the token once. Do not commit it to the repository and do not paste it into source files.
4. In GitHub, open this repository's **Settings → Secrets and variables → Actions → New repository secret**.
5. Use the secret name `CLOUDFLARE_API_TOKEN` and paste the token as its secret value.
6. Run the workflow **Deploy TradeSight 2.0 to Cloudflare Workers** manually once, or push a change to the `v2/` folder on `tradesight-2-foundation`.

The account ID is already configured in the workflow. The Worker name is taken from `v2/package.json` (`tradesight-v2`). The expected production address is `https://tradesight-v2.<your-workers-subdomain>.workers.dev` once the first deployment succeeds and the account's workers.dev subdomain is enabled.

## Publishing workflow

The current Cloudflare workflow is **manual-only** (`workflow_dispatch`). A push to `tradesight-2-foundation` runs CI but does not deploy the website automatically.

To publish, open the repository's **Actions** tab, select **Deploy TradeSight 2.0 to Cloudflare Workers**, and choose **Run workflow**. The workflow runs dependency installation, type checks, unit tests and the Vite production build before deploying the static assets.

No Render or Railway service is involved. A static-only Worker means this website does not need a continuously running backend process.

## Important market-data limitation

The client still needs a market-data source. Free feed tiers can have licensing restrictions and symbol/connection limits. Do not place one developer's SiftingIO key in the public website or redistribute a shared key. Each user must use a key permitted by that provider's terms. Cloudflare hosting does not change the upstream data provider's licensing.
