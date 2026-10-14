const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function hashToken(value) {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export async function pkceChallenge(verifier) {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

export async function encrypt(value, secret) {
  if (!/^[0-9a-f]{64}$/i.test(secret || '')) throw new Error('TOKEN_ENCRYPTION_KEY must be a random 32-byte key encoded as 64 hex characters.');
  const keyBytes = Uint8Array.from(secret.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

export async function decrypt(value, secret) {
  if (!/^[0-9a-f]{64}$/i.test(secret || '')) throw new Error('TOKEN_ENCRYPTION_KEY must be a random 32-byte key encoded as 64 hex characters.');
  const [ivPart, dataPart] = value.split('.');
  const keyBytes = Uint8Array.from(secret.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(ivPart) }, key, fromBase64Url(dataPart));
  return JSON.parse(decoder.decode(plain));
}

export const currentTime = () => Math.floor(Date.now() / 1000);
