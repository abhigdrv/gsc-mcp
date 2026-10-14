import { decrypt, encrypt } from './crypto.js';
import { getGoogleTokens, storeGoogleAccount } from './db.js';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export async function refreshGoogleAccess(env, userId, currentTokens) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: currentTokens.refresh_token,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || 'Google access expired. Reconnect your Google account.');
  const tokens = { ...currentTokens, ...data, refresh_token: data.refresh_token || currentTokens.refresh_token, expiry_date: Date.now() + Number(data.expires_in || 3600) * 1000 };
  const { email } = await getGoogleTokens(env, userId);
  await storeGoogleAccount(env, userId, email, tokens);
  return tokens;
}

export async function getValidGoogleTokens(env, userId, force = false) {
  const { tokens } = await getGoogleTokens(env, userId);
  if (force || !tokens.access_token || Number(tokens.expiry_date || 0) < Date.now() + 60_000) {
    return refreshGoogleAccess(env, userId, tokens);
  }
  return tokens;
}

export async function googleApi(env, userId, url, init = {}) {
  let tokens = await getValidGoogleTokens(env, userId);
  let response = await fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${tokens.access_token}` } });
  if (response.status === 401) {
    tokens = await refreshGoogleAccess(env, userId, tokens);
    response = await fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${tokens.access_token}` } });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || 'Google Search Console request failed.';
    throw new Error(response.status === 401 || response.status === 403 ? `${detail} Confirm this account can access the property and the Search Console API is enabled.` : detail);
  }
  return data;
}

export async function revokeGoogleAccount(env, encryptedTokens) {
  if (!encryptedTokens) return false;
  try {
    const tokens = await decrypt(encryptedTokens, env.TOKEN_ENCRYPTION_KEY);
    if (!tokens.refresh_token) return false;
    const body = new URLSearchParams({ token: tokens.refresh_token });
    const response = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    return response.ok;
  } catch { return false; }
}
