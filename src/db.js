import { currentTime, decrypt, encrypt } from './crypto.js';

export async function findClient(env, clientId) {
  const row = await env.DB.prepare('SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id=?').bind(clientId).first();
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) } : null;
}

export async function insertClient(env, clientId, redirectUris) {
  await env.DB.prepare('INSERT INTO oauth_clients(client_id,redirect_uris,created_at) VALUES(?,?,?)')
    .bind(clientId, JSON.stringify(redirectUris), currentTime()).run();
}

export async function insertTransaction(env, id, data) {
  await env.DB.prepare('INSERT INTO oauth_transactions(id,data,expires_at) VALUES(?,?,?)')
    .bind(id, JSON.stringify(data), currentTime() + 600).run();
}

export async function consumeTransaction(env, id) {
  const row = await env.DB.prepare('DELETE FROM oauth_transactions WHERE id=? AND expires_at>? RETURNING data')
    .bind(id, currentTime()).first();
  return row ? JSON.parse(row.data) : null;
}

export async function storeGoogleAccount(env, userId, email, tokens) {
  const old = await env.DB.prepare('SELECT encrypted_tokens FROM google_accounts WHERE user_id=?').bind(userId).first();
  const previous = old ? await decrypt(old.encrypted_tokens, env.TOKEN_ENCRYPTION_KEY) : {};
  const merged = { ...previous, ...tokens, refresh_token: tokens.refresh_token || previous.refresh_token };
  if (!merged.refresh_token) throw new Error('Google did not return a refresh token. Remove this app from your Google account and reconnect.');
  await env.DB.prepare(`INSERT INTO google_accounts(user_id,email,encrypted_tokens,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email, encrypted_tokens=excluded.encrypted_tokens, updated_at=excluded.updated_at`)
    .bind(userId, email, await encrypt(merged, env.TOKEN_ENCRYPTION_KEY), currentTime()).run();
}

export async function getGoogleTokens(env, userId) {
  const row = await env.DB.prepare('SELECT encrypted_tokens,email FROM google_accounts WHERE user_id=?').bind(userId).first();
  if (!row) throw new Error('Google is not connected. Reconnect this app and approve Google access.');
  return { tokens: await decrypt(row.encrypted_tokens, env.TOKEN_ENCRYPTION_KEY), email: row.email };
}

export async function deleteGoogleAccount(env, userId) {
  const row = await env.DB.prepare('DELETE FROM google_accounts WHERE user_id=? RETURNING encrypted_tokens').bind(userId).first();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_tokens WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM oauth_codes WHERE user_id=?').bind(userId)
  ]);
  return row?.encrypted_tokens || null;
}

export async function insertCode(env, values) {
  await env.DB.prepare(`INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,resource,scopes,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`)
    .bind(values.codeHash, values.clientId, values.userId, values.redirectUri, values.challenge, values.resource, JSON.stringify(values.scopes), currentTime() + 180).run();
}

export async function consumeCode(env, codeHash, clientId, redirectUri) {
  const row = await env.DB.prepare(`DELETE FROM oauth_codes WHERE code_hash=? AND client_id=? AND redirect_uri=? AND expires_at>? RETURNING *`)
    .bind(codeHash, clientId, redirectUri, currentTime()).first();
  return row ? { ...row, scopes: JSON.parse(row.scopes) } : null;
}

export async function addAccessToken(env, tokenHash, values) {
  await env.DB.prepare(`INSERT INTO oauth_tokens(token_hash,token_type,client_id,user_id,resource,scopes,expires_at,created_at)
    VALUES(?,'access',?,?,?,?,?,?)`)
    .bind(tokenHash, values.clientId, values.userId, values.resource, JSON.stringify(values.scopes), currentTime() + 3600, currentTime()).run();
}

export async function addRefreshToken(env, tokenHash, values) {
  await env.DB.prepare(`INSERT INTO oauth_tokens(token_hash,token_type,client_id,user_id,resource,scopes,expires_at,created_at)
    VALUES(?,'refresh',?,?,?,?,?,?)`)
    .bind(tokenHash, values.clientId, values.userId, values.resource, JSON.stringify(values.scopes), currentTime() + 180 * 86400, currentTime()).run();
}

export async function consumeRefreshToken(env, tokenHash, clientId) {
  const row = await env.DB.prepare(`DELETE FROM oauth_tokens WHERE token_hash=? AND token_type='refresh' AND client_id=? AND expires_at>? RETURNING *`)
    .bind(tokenHash, clientId, currentTime()).first();
  return row ? { ...row, scopes: JSON.parse(row.scopes) } : null;
}

export async function findAccessToken(env, tokenHash) {
  const row = await env.DB.prepare(`SELECT user_id,resource,scopes,expires_at FROM oauth_tokens WHERE token_hash=? AND token_type='access' AND expires_at>?`)
    .bind(tokenHash, currentTime()).first();
  return row ? { ...row, scopes: JSON.parse(row.scopes) } : null;
}

export async function accountStatus(env, userId) {
  return env.DB.prepare('SELECT email,updated_at FROM google_accounts WHERE user_id=?').bind(userId).first();
}

export async function cleanup(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_tokens WHERE expires_at<?').bind(currentTime()),
    env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at<?').bind(currentTime()),
    env.DB.prepare('DELETE FROM oauth_transactions WHERE expires_at<?').bind(currentTime()),
    env.DB.prepare(`DELETE FROM oauth_clients WHERE created_at<? AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_codes)`).bind(currentTime() - 90 * 86400)
  ]);
}
