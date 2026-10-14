# Google Search Console and Analytics for ChatGPT

A multi-user, read-only MCP app for Google Search Console and Google Analytics 4. Each ChatGPT user authorizes their own Google account. The Worker encrypts Google OAuth tokens in Cloudflare D1; it does not share one user's credentials with another.

## Tools

- `gsc_connection_status` — show the connected Google account.
- `gsc_list_sites` — list accessible Search Console properties.
- `gsc_search_analytics` — query clicks, impressions, CTR, and average position.
- `gsc_list_sitemaps` — inspect sitemap processing status.
- `ga_connection_status` — show the same Google account connection status for Analytics.
- `ga_list_properties` — list accessible Analytics accounts and GA4 properties.
- `ga_run_report` — run a read-only GA4 report with selected dimensions and metrics.
- `ga_get_metadata` — discover dimensions and metrics supported for a GA4 property.
- `gsc_disconnect` — revoke the Google grant and remove credentials used by both services.

Both APIs use a single Google authorization and one ChatGPT MCP connection. Google tokens previously stored by a separate deployment are not transferred; those users must connect again to grant access to both APIs.

## Deploy on Cloudflare Workers

The app uses Workers, D1, and Web Crypto. Cloudflare Free plan quotas can suit prototypes and small usage; requests or database queries may pause at the applicable limits. Review Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing and limits](https://developers.cloudflare.com/d1/platform/pricing/) before broad adoption.

1. Install dependencies and authenticate Wrangler:

   ```sh
   npm install
   npx wrangler login
   ```

2. Create a D1 database with `npm run db:create`, then put its database ID in `wrangler.jsonc`.

3. Configure a custom domain and set `BASE_URL` to its origin, such as `https://gsc.example.com`.

4. In Google Cloud Console, enable **Google Search Console API**, **Google Analytics Admin API**, and **Google Analytics Data API**. Configure the OAuth consent screen with both read-only scopes:

   ```text
   https://www.googleapis.com/auth/webmasters.readonly
   https://www.googleapis.com/auth/analytics.readonly
   ```

   Create a Web application OAuth client and add this exact authorized redirect URI:

   ```text
   https://gsc.example.com/oauth/google/callback
   ```

5. Set Worker secrets without committing them. Generate a 32-byte encryption key and retain a secure backup; losing or changing it prevents decryption of already-stored credentials.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put TOKEN_ENCRYPTION_KEY
   ```

6. Apply the migration and deploy:

   ```sh
   npm run db:migrate:remote
   npm run deploy
   ```

7. Check `/healthz`, then add `https://gsc.example.com/mcp` as a custom MCP app in ChatGPT with OAuth authentication. Each user connects their Google account and grants both read-only scopes.

For local development, copy `.dev.vars.example` to `.dev.vars`, set test credentials, and run `npm run dev`. Add `http://localhost:8787/oauth/google/callback` as an authorized redirect URI.

## Public availability

Google may require OAuth verification before unrelated public users can authorize the app. Verification may require an owned domain, public homepage and privacy policy, consent-screen branding, scope justification, and product demonstration. Review Google's [sensitive-scope verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

Deploying does not automatically list the app in ChatGPT's public directory. Create and validate the custom MCP app, then publish it to the intended workspace if the plan and permissions allow it. See OpenAI's [custom MCP app guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps).

## Security and data

- MCP access tokens are random and short-lived; only token hashes are stored. Refresh tokens rotate and expire after six months of inactivity.
- Google refresh and access tokens are encrypted with AES-GCM before D1 storage.
- OAuth uses authorization code with PKCE S256, one-time state, and a verified Google ID token nonce.
- Dynamic OAuth clients are restricted to ChatGPT callback URLs, with localhost allowed for development.
- A daily Cron Trigger removes expired OAuth state and tokens.
- `gsc_disconnect` revokes the Google grant and deletes saved credentials and MCP tokens.

Publish a privacy policy describing the stored Google email and encrypted OAuth tokens, their use, retention, and deletion. Restrict access to Cloudflare and Google Cloud credentials and back up D1 and the encryption key with separate access controls.
