#!/usr/bin/env node
/**
 * HAR -> Ordered API Sequence Report + Postman Collection
 *
 * USAGE:
 *   node har-to-postman.js <input.har> [output-folder]
 *
 * OUTPUTS (in output folder):
 *   - <name>-report.csv                 : Excel-friendly, one row per REST call, ordered by initiator
 *   - <name>-report.html                : Visual report ordered by initiator (open in browser)
 *   - <name>.postman_collection.json    : Import directly into Postman (same order)
 *   - <name>.postman_environment.json   : baseUrl variable
 *
 * ORDERING (per request):
 *   1) initiator.type   (xhr, fetch, script, parser, other, preflight, ...)
 *   2) initiator.url    (originating script / page that fired the call)
 *   3) startedDateTime  (chronological tiebreaker — real capture time)
 *   4) log entry index  (stable fallback when startedDateTime is equal)
 *
 * This gives the .NET dev the exact same order the browser issued the calls,
 * which is normally the business-flow order the app performs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ----------------------------- Header sets ----------------------------- */

const STANDARD_REQUEST_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control',
  'connection', 'content-length', 'content-type', 'cookie', 'host',
  'origin', 'pragma', 'referer', 'user-agent', 'upgrade-insecure-requests',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'if-none-match', 'if-modified-since', 'dnt', 'te', 'transfer-encoding',
  'date', 'expires', 'vary', 'etag', 'last-modified', 'age', 'via',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'x-real-ip', 'x-request-id', 'x-correlation-id', 'x-b3-traceid',
  'x-b3-spanid', 'x-b3-parentspanid', 'x-b3-sampled', 'x-b3-flags',
  'traceparent', 'tracestate',
]);

const STANDARD_RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'content-encoding', 'cache-control',
  'connection', 'date', 'etag', 'expires', 'last-modified', 'pragma',
  'server', 'vary', 'transfer-encoding', 'via', 'age', 'accept-ranges',
  'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-expose-headers', 'access-control-max-age',
  'x-content-type-options', 'x-frame-options', 'x-xss-protection',
  'strict-transport-security', 'content-security-policy',
  'referrer-policy', 'permissions-policy',
]);

const BUSINESS_HEADER_HINTS = [
  'authorization', 'x-api-key', 'api-key', 'apikey', 'token',
  'x-auth', 'x-access-token', 'x-csrf', 'x-xsrf', 'x-tenant',
  'x-client', 'x-app', 'x-user', 'x-request', 'x-correl',
  'x-trace', 'x-b3', 'saml', 'bearer', 'session',
];

/* ------------------------------ Utilities ------------------------------ */

function splitHeaders(arr, type = 'request') {
  const standard = {};
  const business = {};
  (arr || []).forEach((h) => {
    const n = (h.name || '').toLowerCase();
    const isStd = type === 'request'
      ? STANDARD_REQUEST_HEADERS.has(n)
      : STANDARD_RESPONSE_HEADERS.has(n);
    if (isStd) standard[h.name] = h.value;
    else business[h.name] = h.value;
  });
  return { standard, business };
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function prettyJson(str) {
  const j = safeJsonParse(str);
  return j ? JSON.stringify(j, null, 2) : str;
}

function truncate(str, n) {
  if (str == null) return '';
  const s = String(str);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function slugify(s) {
  return String(s).replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'request';
}

function sanitizeFolderName(name) {
  return String(name || 'root').replace(/[^\w\- .]/g, '_').slice(0, 60) || 'root';
}

function urlToPostmanParts(urlStr) {
  try {
    const u = new URL(urlStr);
    const pathParts = u.pathname.split('/').filter(Boolean);
    const query = [];
    u.searchParams.forEach((v, k) => query.push({ key: k, value: v }));
    return {
      raw: urlStr,
      protocol: u.protocol.replace(':', ''),
      host: u.hostname.split('.'),
      port: u.port || undefined,
      path: pathParts,
      query,
    };
  } catch {
    return { raw: urlStr };
  }
}

function methodIsApi(method, mimeType) {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) return false;
  if (mimeType && /json|xml|text\/plain|x-www-form-urlencoded|graphql/i.test(mimeType)) return true;
  if (mimeType && /image|font|css|javascript|html|octet-stream/i.test(mimeType)) return false;
  return true;
}

/* --------------------------- Ordering logic ---------------------------- */

/**
 * Normalize initiator into a sortable descriptor.
 * Chrome HAR v1.2 puts initiator under entry._initiator
 * (note: underscore!). Some tools use entry.initiator (no underscore),
 * Firefox typically does not include initiator.
 */
function getInitiator(entry) {
  const raw = entry._initiator || entry.initiator || {};
  const type = String(raw.type || 'other').toLowerCase();
  // Some initiators carry a `url`; others carry `stack.callFrames[i].url`
  let url = raw.url || '';
  if (!url && raw.stack && Array.isArray(raw.stack.callFrames)) {
    const frame = raw.stack.callFrames.find((f) => f && f.url);
    if (frame) url = frame.url;
  }
  let lineNumber = '';
  if (raw.stack && Array.isArray(raw.stack.callFrames) && raw.stack.callFrames[0]) {
    lineNumber = raw.stack.callFrames[0].lineNumber ?? '';
  }
  return { type, url, lineNumber };
}

/**
 * Sort entries ascending by:
 *   1) initiator type
 *   2) initiator url
 *   3) startedDateTime (real capture time)
 *   4) original index
 * Then re-index with a stable Seq number (1..N).
 */
function orderEntriesByInitiator(entries) {
  const decorated = entries.map((entry, idx) => ({
    entry,
    idx,
    initiator: getInitiator(entry),
    started: Date.parse(entry.startedDateTime) || 0,
  }));

  decorated.sort((a, b) => {
    // 1) initiator.type
    if (a.initiator.type !== b.initiator.type) {
      return a.initiator.type.localeCompare(b.initiator.type);
    }
    // 2) initiator.url
    if (a.initiator.url !== b.initiator.url) {
      return (a.initiator.url || '').localeCompare(b.initiator.url || '');
    }
    // 3) actual capture time (ascending)
    if (a.started !== b.started) return a.started - b.started;
    // 4) stable fallback
    return a.idx - b.idx;
  });

  // Rebuild original-index lookup for the raw ordering
  return decorated.map((d, i) => ({
    seq: i + 1,
    ...d,
  }));
}

/* --------------------------- Report building --------------------------- */

function buildReportRows(har) {
  const entries = (har.log && har.log.entries) || [];
  const ordered = orderEntriesByInitiator(entries);
  const rows = [];

  ordered.forEach(({ seq, entry, initiator }) => {
    const req = entry.request || {};
    const res = entry.response || {};
    const method = (req.method || 'GET').toUpperCase();
    const url = req.url || '';
    const mime = (res.content && res.content.mimeType) || '';

    // Keep only API-looking calls (report filter, not ordering filter)
    if (!methodIsApi(method, mime)) return;

    let parsed;
    try { parsed = new URL(url); } catch { parsed = { origin: '', pathname: url, search: '' }; }

    const { standard: stdReqH, business: bizReqH } = splitHeaders(req.headers, 'request');
    const { standard: stdResH, business: bizResH } = splitHeaders(res.headers, 'response');

    const reqBody = (req.postData && req.postData.text) || '';
    const resBody = (res.content && res.content.text) || '';

    rows.push({
      seq,
      method,
      initiatorType: initiator.type,
      initiatorUrl: initiator.url,
      host: parsed.origin || '',
      uri: (parsed.pathname || '') + (parsed.search || ''),
      fullUrl: url,
      status: res.status || '',
      statusText: res.statusText || '',
      contentType: mime,
      businessHeaders: JSON.stringify(bizReqH),
      standardHeaders: JSON.stringify(stdReqH),
      requestBody: truncate(reqBody, 500),
      requestBodyFull: reqBody,
      responseHeaders: JSON.stringify({ standard: stdResH, business: bizResH }),
      responseBody: truncate(resBody, 500),
      responseBodyFull: resBody,
    });
  });

  return rows;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function writeCsv(rows, filePath) {
  const headers = [
    'Seq', 'Method', 'Initiator Type', 'Initiator URL',
    'Host', 'URI', 'Full URL', 'Status', 'Status Text', 'Content-Type',
    'Business Headers', 'Standard Headers', 'Request Body',
    'Response Headers', 'Response Body',
  ];
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach((r) => {
    lines.push([
      r.seq, r.method, r.initiatorType, r.initiatorUrl,
      r.host, r.uri, r.fullUrl, r.status, r.statusText, r.contentType,
      r.businessHeaders, r.standardHeaders, r.requestBody,
      r.responseHeaders, r.responseBody,
    ].map(csvEscape).join(','));
  });
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
}

function writeHtml(rows, filePath, title) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const rowsHtml = rows.map((r) => `
    <tr>
      <td class="seq">${r.seq}</td>
      <td><span class="method ${esc(r.method)}">${esc(r.method)}</span></td>
      <td><span class="init ${esc(r.initiatorType)}">${esc(r.initiatorType)}</span></td>
      <td class="url" title="${esc(r.initiatorUrl)}">${esc(truncate(r.initiatorUrl, 60))}</td>
      <td class="url" title="${esc(r.fullUrl)}">${esc(r.uri)}</td>
      <td>${esc(r.status)}</td>
      <td>${esc(r.contentType)}</td>
      <td class="code" title="${esc(r.businessHeaders)}">${esc(truncate(r.businessHeaders, 80))}</td>
      <td class="code" title="${esc(r.standardHeaders)}">${esc(truncate(r.standardHeaders, 80))}</td>
      <td class="code" title="${esc(r.requestBodyFull)}">${esc(r.requestBody)}</td>
      <td class="code" title="${esc(r.responseBodyFull)}">${esc(r.responseBody)}</td>
    </tr>`).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 20px; background:#f7f8fa; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color:#666; margin-bottom:10px; font-size:13px; }
  table { border-collapse: collapse; width:100%; background:#fff; font-size:12px; }
  th, td { border:1px solid #e1e4e8; padding:6px 8px; vertical-align:top; text-align:left; }
  th { background:#24292e; color:#fff; position:sticky; top:0; }
  tr:nth-child(even) td { background:#fafbfc; }
  td.seq { font-weight:700; color:#0366d6; text-align:center; }
  td.code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size:11px; max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  td.url { max-width: 320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .method { padding:1px 6px; border-radius:4px; font-weight:600; color:#fff; font-size:11px; }
  .method.GET{background:#61affe}.method.POST{background:#49cc90}
  .method.PUT{background:#fca130}.method.PATCH{background:#50e3c2;color:#000}
  .method.DELETE{background:#f93e3e}.method.OPTIONS{background:#0f6ab4}
  .method.HEAD{background:#9012fe}
  .init { padding:1px 6px; border-radius:4px; background:#eef; color:#333; font-size:11px; text-transform:lowercase; }
  .init.xhr{background:#d7f1d5}.init.fetch{background:#ffe8b3}
  .init.script{background:#e0d7ff}.init.parser{background:#d7ecff}
  .init.preflight{background:#ffd7d7}.init.other{background:#eee}
  input#filter { margin:8px 0; padding:6px 10px; width:340px; border:1px solid #ccc; border-radius:4px; }
</style></head><body>
<h1>${esc(title)} — API Sequence Report</h1>
<div class="meta">${rows.length} REST calls &nbsp;|&nbsp; ordered by initiator (asc) then timestamp &nbsp;|&nbsp; generated ${new Date().toISOString()}</div>
<input id="filter" placeholder="Filter sequence / method / URL / initiator..." />
<table id="tbl">
<thead><tr>
  <th>Seq</th><th>Method</th><th>Initiator</th><th>Initiator URL</th><th>URI</th>
  <th>Status</th><th>Content-Type</th>
  <th>Business Headers</th><th>Standard Headers</th>
  <th>Request Body</th><th>Response Body</th>
</tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
<script>
  document.getElementById('filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#tbl tbody tr').forEach((tr) => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
</script>
</body></html>`;
  fs.writeFileSync(filePath, html, 'utf8');
}

/* -------------------------- Postman building --------------------------- */

function harToPostmanItem(entry, usedNames) {
  const req = entry.request || {};
  const res = entry.response || {};
  const method = (req.method || 'GET').toUpperCase();
  const url = req.url || '';
  const mime = res.content && res.content.mimeType;
  if (!methodIsApi(method, mime)) return null;

  const initiator = getInitiator(entry);

  const reqHeaders = (req.headers || []).map((h) => ({
    key: h.name, value: h.value, type: 'text',
  }));

  let body;
  const reqBody = req.postData;
  if (reqBody) {
    const text = reqBody.text || '';
    if (reqBody.mimeType && reqBody.mimeType.includes('json')) {
      body = { mode: 'raw', raw: prettyJson(text), options: { raw: { language: 'json' } } };
    } else if (reqBody.mimeType && reqBody.mimeType.includes('x-www-form-urlencoded') && reqBody.params) {
      body = {
        mode: 'urlencoded',
        urlencoded: reqBody.params.map((p) => ({ key: p.name, value: p.value, type: 'text' })),
      };
    } else if (text) {
      body = { mode: 'raw', raw: text };
    }
  }

  // Name: METHOD + short path, dedupe
  let baseName = `${method} ${new URL(url).pathname}`;
  let name = baseName;
  let i = 2;
  while (usedNames.has(name)) name = `${baseName} (${i++})`;
  usedNames.add(name);

  const item = {
    name,
    request: {
      method,
      header: reqHeaders,
      url: urlToPostmanParts(url),
      description:
        `Captured: ${entry.startedDateTime || 'n/a'}\n` +
        `Initiator: ${initiator.type}${initiator.url ? ' -> ' + initiator.url : ''}\n` +
        `Status: ${res.status} ${res.statusText || ''}`,
    },
    response: [],
  };
  if (body) item.request.body = body;

  if (res.content && res.content.text) {
    item.response.push({
      name: `${res.status} ${res.statusText || ''}`.trim(),
      originalRequest: item.request,
      status: res.statusText || '',
      code: res.status || 0,
      _postman_previewlanguage: (res.content.mimeType || '').includes('json') ? 'json' : 'text',
      header: (res.headers || []).map((h) => ({ key: h.name, value: h.value })),
      cookie: [],
      body: res.content.text,
    });
  }

  return item;
}

function buildPostmanCollection(har, name) {
  const entries = (har.log && har.log.entries) || [];
  const ordered = orderEntriesByInitiator(entries);
  const groups = new Map();
  const usedNames = new Set();

  let host = '';
  try { host = new URL(entries[0].request.url).origin; } catch { /* ignore */ }

  // Iterate in initiator order; folder is by first path segment.
  ordered.forEach(({ entry }) => {
    const item = harToPostmanItem(entry, usedNames);
    if (!item) return;
    let folder;
    try {
      folder = sanitizeFolderName(
        new URL(entry.request.url).pathname.split('/').filter(Boolean)[0] || 'root'
      );
    } catch { folder = 'root'; }
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  });

  const folderItems = [...groups.entries()].map(([folderName, items]) => ({
    name: folderName,
    item: items,
  }));

  const totalRequests = folderItems.reduce((a, f) => a + f.item.length, 0);

  const collection = {
    info: {
      _postman_id: crypto.randomUUID(),
      name: `${name} (from HAR)`,
      description:
        `Auto-generated from HAR on ${new Date().toISOString()}.\n` +
        `Base URL: ${host}\n` +
        `Total REST requests: ${totalRequests}\n` +
        `Order: initiator type -> initiator url -> startedDateTime (matches browser flow).`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: folderItems,
    variable: [{ key: 'baseUrl', value: host || 'http://localhost' }],
  };

  const environment = {
    id: crypto.randomUUID(),
    name: `${name} ENV`,
    values: [{ key: 'baseUrl', value: host || 'http://localhost', type: 'default', enabled: true }],
    _postman_variable_scope: 'environment',
  };

  return { collection, environment };
}

/* -------------------------------- Main -------------------------------- */

function main() {
  const [, , inputArg, outArg] = process.argv;
  if (!inputArg) {
    console.error('Usage: node har-to-postman.js <input.har> [output-folder]');
    process.exit(1);
  }
  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const baseName = slugify(path.basename(inputPath, path.extname(inputPath)));
  const outputDir = outArg ? path.resolve(outArg) : path.dirname(inputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  const harText = fs.readFileSync(inputPath, 'utf8');
  let har;
  try { har = JSON.parse(harText); }
  catch (e) { console.error('Invalid HAR / JSON:', e.message); process.exit(1); }

  if (!har.log || !Array.isArray(har.log.entries)) {
    console.error('Not a valid HAR file: missing log.entries');
    process.exit(1);
  }

  // 1. Report rows (already ordered by initiator)
  const rows = buildReportRows(har);
  const csvPath = path.join(outputDir, `${baseName}-report.csv`);
  const htmlPath = path.join(outputDir, `${baseName}-report.html`);
  writeCsv(rows, csvPath);
  writeHtml(rows, htmlPath, path.basename(inputPath));

  // 2. Postman collection (preserves the same order)
  const { collection, environment } = buildPostmanCollection(har, baseName);
  const postmanPath = path.join(outputDir, `${baseName}.postman_collection.json`);
  const envPath = path.join(outputDir, `${baseName}.postman_environment.json`);
  fs.writeFileSync(postmanPath, JSON.stringify(collection, null, 2), 'utf8');
  fs.writeFileSync(envPath, JSON.stringify(environment, null, 2), 'utf8');

  // 3. Console summary
  const byMethod = rows.reduce((a, r) => (a[r.method] = (a[r.method] || 0) + 1, a), {});
  const byInitiator = rows.reduce((a, r) => (a[r.initiatorType] = (a[r.initiatorType] || 0) + 1, a), {});

  console.log('\n✅ HAR processed (ordered by initiator)');
  console.log('   Total entries in HAR :', har.log.entries.length);
  console.log('   REST/API calls found :', rows.length);
  console.log('   Method breakdown     :', byMethod);
  console.log('   Initiator breakdown  :', byInitiator);
  console.log('\n📄 Generated files:');
  console.log('   ', csvPath);
  console.log('   ', htmlPath);
  console.log('   ', postmanPath, '  <- import into Postman');
  console.log('   ', envPath);
  console.log('\n👉 In Postman: Import -> select the .postman_collection.json');
  console.log('   Order = initiator type -> initiator url -> startedDateTime.');
  console.log('   Same order as the real business flow captured in the HAR.\n');
}

main();