import { createRemoteJWKSet, jwtVerify } from 'jose';
import { hashToken, pkceChallenge, randomToken } from './crypto.js';
import { consumeCode, consumeRefreshToken, consumeTransaction, findAccessToken, findClient, insertClient, insertCode, insertTransaction, addAccessToken, addRefreshToken, storeGoogleAccount } from './db.js';
import { GOOGLE_SCOPES } from './google.js';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const allowedScopes = new Set(['gsc.read', 'offline_access']);

export function resourceUrl(env) { return `${env.BASE_URL.replace(/\/$/, '')}/mcp`; }
export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const oauthError = (error, status = 400, description) => json({ error, ...(description ? { error_description: description } : {}) }, status, { 'cache-control': 'no-store' });

function validRedirect(value) {
  try {
    const uri = new URL(value);
    if (uri.hash || uri.username || uri.password) return false;
    return (uri.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(uri.hostname)) ||
      (uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname));
  } catch { return false; }
}

function redirectWith(uri, values) {
  const target = new URL(uri);
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) target.searchParams.set(key, value);
  return Response.redirect(target.toString(), 302);
}

export async function registerClient(request, env) {
  const metadata = await request.json().catch(() => ({}));
  const redirects = metadata.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10 || redirects.some((uri) => typeof uri !== 'string' || !validRedirect(uri))) {
    return oauthError('invalid_redirect_uri', 400, 'Use ChatGPT HTTPS callback URLs (or localhost callback URLs during development).');
  }
  if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== 'none') return oauthError('invalid_client_metadata', 400, 'Only public PKCE clients are supported.');
  const clientId = randomToken(24);
  await insertClient(env, clientId, redirects);
  return json({ client_id: clientId, client_name: String(metadata.client_name || 'ChatGPT MCP client').slice(0, 100), redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
}

export async function authorize(request, env) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const challenge = url.searchParams.get('code_challenge');
  const state = url.searchParams.get('state');
  const method = url.searchParams.get('code_challenge_method');
  if (!clientId || !redirectUri || !challenge || !state || method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return new Response('State and PKCE with S256 are required.', { status: 400 });
  const client = await findClient(env, clientId);
  if (!client || !client.redirect_uris.includes(redirectUri)) return new Response('This OAuth client or callback URL is not registered.', { status: 400 });
  const resource = url.searchParams.get('resource') || resourceUrl(env);
  if (resource !== resourceUrl(env)) return new Response('Requested resource does not match this MCP server.', { status: 400 });
  const scopes = (url.searchParams.get('scope') || 'gsc.read offline_access').split(/\s+/).filter(Boolean);
  if (!scopes.includes('gsc.read') || scopes.some((scope) => !allowedScopes.has(scope))) return new Response('Requested scope is not supported.', { status: 400 });

  const stateId = randomToken(24);
  const nonce = randomToken(24);
  await insertTransaction(env, stateId, { clientId, redirectUri, challenge, state, resource, scopes, nonce });
  const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.BASE_URL.replace(/\/$/, '')}/oauth/google/callback`,
    response_type: 'code',
    scope: `openid email ${GOOGLE_SCOPES.join(' ')}`,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state: stateId,
    nonce
  }).toString();
  return Response.redirect(googleUrl.toString(), 302);
}

export async function googleCallback(request, env) {
  const url = new URL(request.url);
  const stateId = url.searchParams.get('state');
  if (!stateId) return new Response('Missing authorization state. Restart the connection from ChatGPT.', { status: 400 });
  const flow = await consumeTransaction(env, stateId);
  if (!flow) return new Response('Sign-in expired. Restart the connection from ChatGPT.', { status: 400 });
  if (url.searchParams.has('error') || !url.searchParams.get('code')) {
    return redirectWith(flow.redirectUri, { error: 'access_denied', state: flow.state, error_description: 'Google authorization was not completed.' });
  }
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${env.BASE_URL.replace(/\/$/, '')}/oauth/google/callback`, grant_type: 'authorization_code' })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokens.error_description || tokens.error || 'Google token exchange failed.');
    if (tokens.scope) {
      const grantedScopes = new Set(tokens.scope.split(/\s+/));
      if (GOOGLE_SCOPES.some((scope) => !grantedScopes.has(scope))) throw new Error('Google did not grant both Search Console and Analytics read-only access.');
    }
    const { payload } = await jwtVerify(tokens.id_token, googleKeys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID });
    if (payload.nonce !== flow.nonce || !payload.sub || !payload.email || payload.email_verified !== true) throw new Error('Could not verify the Google account identity.');
    tokens.expiry_date = Date.now() + Number(tokens.expires_in || 3600) * 1000;
    await storeGoogleAccount(env, payload.sub, payload.email, tokens);
    const code = randomToken();
    await insertCode(env, { codeHash: await hashToken(code), clientId: flow.clientId, userId: payload.sub, redirectUri: flow.redirectUri, challenge: flow.challenge, resource: flow.resource, scopes: flow.scopes });
    return redirectWith(flow.redirectUri, { code, state: flow.state });
  } catch (error) {
    console.error('Google OAuth callback failed:', error.message);
    return redirectWith(flow.redirectUri, { error: 'access_denied', state: flow.state, error_description: 'Google Search Console authorization could not be completed.' });
  }
}

async function issueTokenSet(env, clientId, userId, resource, scopes) {
  const accessToken = randomToken();
  const refreshToken = scopes.includes('offline_access') ? randomToken() : null;
  const values = { clientId, userId, resource, scopes };
  await addAccessToken(env, await hashToken(accessToken), values);
  if (refreshToken) await addRefreshToken(env, await hashToken(refreshToken), values);
  return { accessToken, refreshToken };
}

export async function token(request, env) {
  const body = new URLSearchParams(await request.text());
  const grantType = body.get('grant_type');
  const clientId = body.get('client_id');
  const resource = body.get('resource');
  if (grantType === 'authorization_code') {
    const code = body.get('code');
    const redirectUri = body.get('redirect_uri');
    const verifier = body.get('code_verifier');
    if (!code || !clientId || !redirectUri || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError('invalid_request');
    const grant = await consumeCode(env, await hashToken(code), clientId, redirectUri);
    if (!grant || (resource && resource !== grant.resource) || await pkceChallenge(verifier) !== grant.code_challenge) return oauthError('invalid_grant');
    const issued = await issueTokenSet(env, clientId, grant.user_id, grant.resource, grant.scopes);
    return json({ access_token: issued.accessToken, token_type: 'Bearer', expires_in: 3600, ...(issued.refreshToken ? { refresh_token: issued.refreshToken } : {}), scope: grant.scopes.join(' ') }, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
  }
  if (grantType === 'refresh_token') {
    const refreshToken = body.get('refresh_token');
    if (!refreshToken || !clientId) return oauthError('invalid_request');
    const grant = await consumeRefreshToken(env, await hashToken(refreshToken), clientId);
    if (!grant || (resource && resource !== grant.resource)) return oauthError('invalid_grant');
    const issued = await issueTokenSet(env, clientId, grant.user_id, grant.resource, grant.scopes);
    return json({ access_token: issued.accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: issued.refreshToken, scope: grant.scopes.join(' ') }, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
  }
  return oauthError('unsupported_grant_type');
}

export async function authenticate(request, env) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') || '');
  if (!match) return null;
  const grant = await findAccessToken(env, await hashToken(match[1]));
  if (!grant || grant.resource !== resourceUrl(env) || !grant.scopes.includes('gsc.read')) return null;
  return { token: match[1], clientId: grant.client_id, scopes: grant.scopes, expiresAt: grant.expires_at, resource: grant.resource, extra: { userId: grant.user_id } };
}

export function authorizationServerMetadata(env) {
  const issuer = env.BASE_URL.replace(/\/$/, '');
  return { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['gsc.read', 'offline_access'] };
}

export function protectedResourceMetadata(env) {
  const issuer = env.BASE_URL.replace(/\/$/, '');
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['gsc.read', 'offline_access'] };
}

export function unauthorized(env) {
  const metadataUrl = `${env.BASE_URL.replace(/\/$/, '')}/.well-known/oauth-protected-resource/mcp`;
  return json({ error: 'unauthorized', error_description: 'Connect your Google Search Console account to continue.' }, 401, { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` });
}

