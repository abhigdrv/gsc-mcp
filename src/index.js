import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { accountStatus, cleanup, deleteGoogleAccount } from './db.js';
import { googleApi, revokeGoogleAccount } from './google.js';
import {
  authenticate, authorizationServerMetadata, authorize, googleCallback, json,
  protectedResourceMetadata, registerClient, token, unauthorized
} from './oauth.js';

const serverInfo = { name: 'google-search-console-analytics', version: '4.0.0' };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates.');
const reportDate = z.string().regex(/^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,3}daysAgo)$/, 'Use YYYY-MM-DD, today, yesterday, or a relative date such as 30daysAgo.');
const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/, 'Use a Google Analytics API dimension or metric name.');

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function propertyPath(siteUrl, suffix) {
  return `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/${suffix}`;
}

function propertyId(value) {
  return value.replace(/^properties\//, '');
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

  server.registerTool('ga_connection_status', {
    title: 'Google Analytics connection status',
    description: 'Show the Google account connected to this MCP. Search Console and Analytics use the same Google authorization.',
    inputSchema: z.object({})
  }, async () => {
    const account = await accountStatus(env, userId);
    return textResult(account ? { connected: true, googleAccount: account.email } : { connected: false });
  });

  server.registerTool('ga_list_properties', {
    title: 'List Google Analytics properties',
    description: 'List Google Analytics accounts and GA4 properties accessible to the connected Google account.',
    inputSchema: z.object({
      pageSize: z.number().int().min(1).max(200).default(100),
      pageToken: z.string().optional()
    })
  }, async ({ pageSize, pageToken }) => {
    try {
      const url = new URL('https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
      url.searchParams.set('pageSize', String(pageSize));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await googleApi(env, userId, url.toString());
      return textResult({
        accounts: (data.accountSummaries || []).map((account) => ({
          account: account.account,
          accountName: account.displayName,
          properties: (account.propertySummaries || []).map((property) => ({
            property: property.property,
            propertyId: propertyId(property.property),
            propertyName: property.displayName,
            propertyType: property.propertyType
          }))
        })),
        nextPageToken: data.nextPageToken || null
      });
    } catch (error) { return textResult({ error: error.message }); }
  });

  server.registerTool('ga_run_report', {
    title: 'Run a Google Analytics report',
    description: 'Query read-only GA4 reports for a property. Use ga_get_metadata to find valid dimensions and metrics.',
    inputSchema: z.object({
      property: z.string().regex(/^(properties\/)?\d+$/).describe('GA4 property ID, with or without the properties/ prefix.'),
      startDate: reportDate,
      endDate: reportDate,
      dimensions: z.array(fieldName).max(9).default(['date']),
      metrics: z.array(fieldName).min(1).max(10).default(['sessions', 'activeUsers']),
      limit: z.number().int().min(1).max(10000).default(100)
    })
  }, async ({ property, startDate, endDate, dimensions, metrics, limit }) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && startDate > endDate) {
      return textResult({ error: 'startDate must be on or before endDate.' });
    }
    const id = propertyId(property);
    try {
      const data = await googleApi(env, userId, `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(id)}:runReport`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensions: dimensions.map((name) => ({ name })),
          metrics: metrics.map((name) => ({ name })),
          limit: String(limit)
        })
      });
      const dimensionHeaders = (data.dimensionHeaders || []).map((header) => header.name);
      const metricHeaders = (data.metricHeaders || []).map((header) => header.name);
      const rows = (data.rows || []).map((row) => ({
        dimensions: Object.fromEntries(dimensionHeaders.map((name, index) => [name, row.dimensionValues?.[index]?.value ?? null])),
        metrics: Object.fromEntries(metricHeaders.map((name, index) => [name, row.metricValues?.[index]?.value ?? null]))
      }));
      return textResult({ property: `properties/${id}`, startDate, endDate, dimensionHeaders, metricHeaders, rowCount: data.rowCount ?? rows.length, rows });
    } catch (error) { return textResult({ error: error.message }); }
  });

  server.registerTool('ga_get_metadata', {
    title: 'Explore Google Analytics dimensions and metrics',
    description: 'Find valid GA4 dimensions and metrics for a property, optionally filtering by a search term.',
    inputSchema: z.object({
      property: z.string().regex(/^(properties\/)?\d+$/).describe('GA4 property ID, with or without the properties/ prefix.'),
      searchTerm: z.string().max(100).optional()
    })
  }, async ({ property, searchTerm }) => {
    const id = propertyId(property);
    try {
      const data = await googleApi(env, userId, `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(id)}/metadata`);
      const term = (searchTerm || '').toLowerCase();
      const matches = (items = []) => items
        .filter((item) => !term || `${item.apiName} ${item.uiName} ${item.description}`.toLowerCase().includes(term))
        .slice(0, 100)
        .map(({ apiName, uiName, description, deprecated, customDefinition, category }) => ({ apiName, uiName, description, deprecated, customDefinition, category }));
      return textResult({
        property: `properties/${id}`,
        dimensions: matches(data.dimensions),
        metrics: matches(data.metrics),
        note: 'Only the first 100 matching dimensions and metrics of each kind are returned.'
      });
    } catch (error) { return textResult({ error: error.message }); }
  });

  server.registerTool('gsc_disconnect', {
    title: 'Disconnect Google account',
    description: 'Revoke Google access and remove the credentials used by Search Console and Analytics tools in this MCP.',
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
