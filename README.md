# Google Search Console for ChatGPT on Cloudflare Workers

A multi-user, read-only MCP app. Each ChatGPT user signs in to their own Google account. The Worker encrypts that user's Google OAuth tokens in Cloudflare D1 and ties them to that user's MCP access token. No shared Google credential is used across users.

Tools provided:

- `gsc_connection_status` — show the connected Google account.
- `gsc_list_sites` — list properties accessible to that account.
- `gsc_search_analytics` — query clicks, impressions, CTR, and average position.
- `gsc_list_sitemaps` — inspect sitemap processing status.
- `gsc_disconnect` — revoke Google access and remove locally stored credentials.

## Why Cloudflare fits

The server uses a native Workers `fetch` handler, D1 for durable OAuth state and encrypted Google credentials, and Web Crypto for token hashing and encryption. It does not need a VM or always-on Node server. D1 keeps user data available across Worker instances.

Cloudflare's current Free plan includes Workers with a daily request quota and D1 with daily row read/write limits. That is suitable for prototyping and small usage; if usage reaches a limit, requests or database queries can pause until reset or until the account is upgraded. Check Cloudflare's [current Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing and limits](https://developers.cloudflare.com/d1/platform/pricing/) before opening this to a larger user base.

## Deploy to your Cloudflare account

You need a Cloudflare account. For public Google OAuth, use a custom domain that you control and have added to Cloudflare; a `workers.dev` URL is useful for an initial deployment, but doesn't give you an owned domain for Google's public OAuth verification.

1. Install the dependencies and authenticate Wrangler:

   ```sh
   npm install
   npx wrangler login
   ```

2. Create the D1 database:

   ```sh
   npm run db:create
   ```

   Copy the returned database ID into `wrangler.jsonc`, replacing the all-zero placeholder.

3. In Cloudflare, add your domain as a Worker custom domain. Set `BASE_URL` in `wrangler.jsonc` to the exact public origin, for example `https://gsc.example.com`.

4. In Google Cloud Console, enable the **Google Search Console API** and configure the OAuth consent screen. Create a **Web application** OAuth client. Add this exact redirect URI to the OAuth client:

   ```text
   https://gsc.example.com/oauth/google/callback
   ```

5. Add the secrets to the Worker without committing them to source control. Generate an encryption key locally and keep a protected backup; losing or changing it makes existing stored Google tokens unreadable.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put TOKEN_ENCRYPTION_KEY
   ```

   Wrangler prompts for each value. Set the Google client ID and secret from the Cloud Console, and paste the generated 64-character key for `TOKEN_ENCRYPTION_KEY`.

6. Apply the D1 migration and deploy:

   ```sh
   npm run db:migrate:remote
   npm run deploy
   ```

7. Check `https://gsc.example.com/healthz`, then create the custom MCP app in ChatGPT with the endpoint `https://gsc.example.com/mcp` and OAuth authentication. ChatGPT's OAuth discovery endpoints are served by the Worker. Each user authorizes their own Google account when adding/connecting the app.

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in test Google OAuth values, and run `npm run dev`. Add `http://localhost:8787/oauth/google/callback` as an authorized redirect URI in the Google OAuth client.

## Google and ChatGPT availability

This project requests Google's read-only Search Console scope. Google may require OAuth verification before unrelated public users can authorize the app. Verification commonly requires an owned domain, a public homepage and privacy policy, accurate consent-screen branding, a scope justification, and a demo of the product. Review Google's [sensitive-scope verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) before launch.

Deploying the server does not automatically put the app in ChatGPT's public directory. Create and test a custom app in ChatGPT, then publish it to the intended workspace if your plan and permissions allow it. OpenAI's current [custom MCP app guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) describes plan availability and publishing controls.

## Security and data

- MCP tokens are random, short-lived access tokens; only their hashes are stored. Refresh tokens rotate and expire after six months of inactivity.
- Google refresh and access tokens are encrypted using AES-GCM with `TOKEN_ENCRYPTION_KEY` before D1 storage.
- OAuth uses authorization code with PKCE S256, one-time state, and a verified Google ID token with a nonce.
- Dynamic OAuth clients are restricted to ChatGPT callback URLs, with localhost allowed for development.
- A daily Worker Cron Trigger removes expired OAuth state and tokens.
- `gsc_disconnect` revokes Google's refresh token and deletes the user's saved credentials and MCP tokens. Users can also revoke the grant in their Google Account security settings.

Publish a privacy policy that explains the stored Google email address and encrypted OAuth tokens, their use, retention, and deletion. Limit access to the Cloudflare account, D1 database, and Worker secrets. Back up D1 and the encryption key together under separate access controls.
