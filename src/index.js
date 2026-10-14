import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { accountStatus, cleanup, deleteGoogleAccount } from './db.js';
import { googleApi, revokeGoogleAccount } from './google.js';
import {
  authenticate, authorizationServerMetadata, authorize, googleCallback, json,
  protectedResourceMetadata, registerClient, token, unauthorized
} from './oauth.js';

const serverInfo = { name: 'google-search-console', version: '3.0.0' };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates.');

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function propertyPath(siteUrl, suffix) {
  return `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/${suffix}`;
}

function createMcpServer(env, userId) {
  const server = new McpServer(serverInfo);

  server.registerTool('gsc_connection_status', {
    title: 'Google Search Console connection status',
    description: 'Show the Google account connected to this ChatGPT account.',
    inputSchema: z.object({})
  }, async () => {
    const account = await accountStatus(env, userId);
    return textResult(account ? { connected: true, googleAccount: account.email } : { connected: false });
  });

  server.registerTool('gsc_list_sites', {
    title: 'List Search Console properties',
    description: 'List the Search Console properties available to your connected Google account.',
    inputSchema: z.object({})
  }, async () => {
    try {
      const data = await googleApi(env, userId, 'https://www.googleapis.com/webmasters/v3/sites');
      return textResult((data.siteEntry || []).map(({ siteUrl, permissionLevel }) => ({ siteUrl, permissionLevel })));
    } catch (error) { return textResult({ error: error.message }); }
  });

  server.registerTool('gsc_search_analytics', {
    title: 'Query Search Console performance',
    description: 'Get clicks, impressions, CTR, and average position grouped by date, query, page, country, device, or search appearance. Google may omit lower-ranked rows.',
    inputSchema: z.object({
      siteUrl: z.string().min(1).describe('Property exactly as listed in Search Console, or sc-domain:example.com.'),
      startDate: isoDate,
      endDate: isoDate,
      dimensions: z.array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance'])).max(3).default(['query']),
      rowLimit: z.number().int().min(1).max(25000).default(100),
      searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
      query: z.string().optional(),
      page: z.string().optional(),
      country: z.string().length(3).optional().describe('ISO 3166-1 alpha-3 country code, such as usa.'),
      device: z.enum(['DESKTOP', 'MOBILE', 'TABLET']).optional()
    })
  }, async ({ siteUrl, startDate, endDate, dimensions, rowLimit, searchType, query, page, country, device }) => {
    if (startDate > endDate) return textResult({ error: 'startDate must be on or before endDate.' });
    const filters = [];
    for (const [dimension, expression] of [['query', query], ['page', page], ['country', country], ['device', device]]) {
      if (expression) filters.push({ dimension, operator: 'equals', expression });
    }
    try {
      const data = await googleApi(env, userId, propertyPath(siteUrl, 'searchAnalytics/query'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, dimensions, rowLimit, type: searchType, dataState: 'final', ...(filters.length ? { dimensionFilterGroups: [{ groupType: 'and', filters }] } : {}) })
      });
      return textResult({ siteUrl, startDate, endDate, searchType, dimensions, rows: data.rows || [], note: 'Recent dates can take a few days to finalize. Search Console may return only top rows.' });
    } catch (error) { return textResult({ error: error.message }); }
  });

  server.registerTool('gsc_list_sitemaps', {
    title: 'List Search Console sitemaps',
    description: 'List submitted sitemaps and processing status for a property.',
    inputSchema: z.object({ siteUrl: z.string().min(1) })
  }, async ({ siteUrl }) => {
    try {
      const data = await googleApi(env, userId, propertyPath(siteUrl, 'sitemaps'));
      return textResult((data.sitemap || []).map(({ path, lastSubmitted, isPending, isSitemapsIndex, type, warnings, errors, contents }) => ({ path, lastSubmitted, isPending, isSitemapsIndex, type, warnings, errors, contents })));
    } catch (error) { return textResult({ error: error.message }); }
  });

  server.registerTool('gsc_disconnect', {
    title: 'Disconnect Google Search Console',
    description: 'Remove and revoke the Google Search Console credentials connected to this ChatGPT account.',
    inputSchema: z.object({})
  }, async () => {
    try {
      const encrypted = await deleteGoogleAccount(env, userId);
      const revoked = await revokeGoogleAccount(env, encrypted);
      return textResult({ disconnected: true, googleGrantRevoked: revoked });
    } catch (error) { return textResult({ error: error.message }); }
  });

  return server;
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('access-control-allow-headers', 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-Id');
  headers.set('access-control-expose-headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version');
  headers.set('access-control-max-age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const base = new URL(env.BASE_URL);
  if (url.host !== base.host) return new Response('Invalid Host header.', { status: 421 });
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

  if (url.pathname === '/healthz' && request.method === 'GET') return withCors(json({ ok: true }));
  if (url.pathname === '/.well-known/oauth-protected-resource' && request.method === 'GET') return withCors(json(protectedResourceMetadata(env)));
  if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && request.method === 'GET') return withCors(json(protectedResourceMetadata(env)));
  if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') return withCors(json(authorizationServerMetadata(env)));
  if (url.pathname === '/register' && request.method === 'POST') return withCors(await registerClient(request, env));
  if (url.pathname === '/authorize' && request.method === 'GET') return withCors(await authorize(request, env));
  if (url.pathname === '/token' && request.method === 'POST') return withCors(await token(request, env));
  if (url.pathname === '/oauth/google/callback' && request.method === 'GET') return withCors(await googleCallback(request, env));
  if (url.pathname === '/mcp') {
    const authInfo = await authenticate(request, env);
    if (!authInfo) return withCors(unauthorized(env));
    const handler = createMcpHandler(() => createMcpServer(env, authInfo.extra.userId));
    return withCors(await handler.fetch(request, { authInfo }));
  }
  return withCors(new Response('Not found.', { status: 404 }));
}

export default {
  async fetch(request, env) {
    try { return await handleRequest(request, env); }
    catch (error) {
      console.error('Request failed:', error.message);
      return withCors(json({ error: 'internal_error' }, 500));
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  }
};
