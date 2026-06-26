import http from 'node:http';
import https from 'node:https';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 10000);
const TIMEOUT_MS = Number(process.env.WMS_PROXY_TIMEOUT_MS || 60000);
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000);
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 500);

const DEFAULT_ALLOWED_HOSTS = [
  'geoserver.inema.ba.gov.br',
  'geoserver.car.gov.br',
  'geoservicos.ibge.gov.br',
  'geoservicos.inde.gov.br',
  'www.geoservicos.inde.gov.br',
  'geoinfo.dados.embrapa.br',
  'geo.infrasa.gov.br',
  'sig.valec.gov.br'
];

const ALLOWED_HOSTS = new Set([
  ...DEFAULT_ALLOWED_HOSTS,
  ...String(process.env.WMS_PROXY_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
]);

const CORS_ORIGINS = String(
  process.env.CORS_ORIGINS || 'https://georuralpro.vercel.app'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const cache = new Map();
const inFlight = new Map();
const preferredEndpointByHost = new Map();

function isInema(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'inema.ba.gov.br' || value.endsWith('.inema.ba.gov.br');
}

function corsOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return '*';
  return CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin) ? origin : '';
}

function baseHeaders(req) {
  const origin = corsOrigin(req);
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  };
}

function json(req, res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    ...baseHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function decodeTarget(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Informe o parâmetro target.');
  if (/^https?:\/\//i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalizeTarget(raw) {
  let url;
  try { url = new URL(decodeTarget(raw)); }
  catch { throw new Error('URL WMS inválida.'); }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('O target precisa usar HTTP ou HTTPS.');
  }

  const hostname = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(`Domínio WMS não autorizado: ${hostname}`);
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

function uniqueUrls(urls) {
  const seen = new Set();
  return urls.filter((url) => {
    const value = url.toString();
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function candidates(target) {
  const hostname = target.hostname.toLowerCase();
  const list = [];
  const preferred = preferredEndpointByHost.get(hostname);
  if (preferred) list.push(new URL(preferred));
  list.push(new URL(target));

  if (isInema(hostname)) {
    for (const protocol of ['http:', 'https:']) {
      for (const pathname of [target.pathname, '/geoserver/wms', '/geoserver/ows']) {
        const url = new URL(target);
        url.protocol = protocol;
        url.pathname = pathname;
        url.search = '';
        list.push(url);
      }
    }
  } else if (target.protocol === 'http:') {
    const secure = new URL(target);
    secure.protocol = 'https:';
    list.push(secure);
  }

  return uniqueUrls(list);
}

function buildUpstream(endpoint, incoming) {
  const url = new URL(endpoint);
  const incomingKeys = new Set();
  for (const [key] of incoming.entries()) {
    if (key.toLowerCase() !== 'target') incomingKeys.add(key.toLowerCase());
  }
  for (const key of [...url.searchParams.keys()]) {
    if (incomingKeys.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  for (const [key, value] of incoming.entries()) {
    if (key.toLowerCase() !== 'target') url.searchParams.append(key, value);
  }
  if (!url.searchParams.has('SERVICE')) url.searchParams.set('SERVICE', 'WMS');
  if (!url.searchParams.has('REQUEST')) url.searchParams.set('REQUEST', 'GetMap');
  if (!url.searchParams.has('VERSION')) url.searchParams.set('VERSION', '1.1.1');
  if (!url.searchParams.has('STYLES')) url.searchParams.set('STYLES', '');
  return url;
}

function requestBuffer(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const inema = isInema(url.hostname);
    const request = transport.request(url, {
      method: 'GET',
      headers: {
        Accept: 'image/png,image/jpeg,image/*;q=0.9,*/*;q=0.2',
        'Accept-Encoding': 'identity',
        'User-Agent': 'GeoRural-Pro-Azure-BR-WMS-Proxy/1.0',
        Connection: 'close'
      },
      ...(inema ? { family: 4 } : {}),
      ...(url.protocol === 'https:' ? {
        rejectUnauthorized: !inema,
        servername: url.hostname
      } : {})
    }, (upstream) => {
      const status = Number(upstream.statusCode || 0);
      const location = upstream.headers.location;

      if (status >= 300 && status < 400 && location) {
        upstream.resume();
        if (redirectsLeft <= 0) return reject(new Error('Limite de redirecionamentos excedido.'));
        const redirect = new URL(location, url);
        if (!ALLOWED_HOSTS.has(redirect.hostname.toLowerCase())) {
          return reject(new Error(`Redirecionamento bloqueado: ${redirect.hostname}`));
        }
        requestBuffer(redirect, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      const chunks = [];
      let total = 0;
      upstream.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          upstream.destroy(new Error('Resposta WMS maior que 25 MB.'));
          return;
        }
        chunks.push(chunk);
      });
      upstream.once('error', reject);
      upstream.once('end', () => {
        const body = Buffer.concat(chunks);
        const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
        const normalized = contentType.split(';')[0].trim().toLowerCase();
        const png = body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;

        if (status < 200 || status >= 300) {
          const detail = body.toString('utf8', 0, Math.min(body.length, 1000)).replace(/\s+/g, ' ').trim();
          return reject(new Error(`HTTP ${status}${detail ? `: ${detail}` : ''}`));
        }
        if (!body.length) return reject(new Error('Resposta WMS vazia.'));
        if (!normalized.startsWith('image/') && !png && !jpeg) {
          const detail = body.toString('utf8', 0, Math.min(body.length, 1500)).replace(/\s+/g, ' ').trim();
          return reject(new Error(detail || `Content-Type inesperado: ${contentType}`));
        }

        resolve({
          body,
          contentType: normalized.startsWith('image/') ? contentType : (png ? 'image/png' : 'image/jpeg'),
          endpoint: url.toString(),
          etag: upstream.headers.etag || '',
          lastModified: upstream.headers['last-modified'] || ''
        });
      });
    });

    request.setTimeout(TIMEOUT_MS, () => {
      request.destroy(new Error(`Tempo limite de ${Math.round(TIMEOUT_MS / 1000)} segundos excedido.`));
    });
    request.once('error', reject);
    request.end();
  });
}

async function fetchFirst(target, incoming) {
  const attempts = [];
  for (const endpoint of candidates(target)) {
    const upstream = buildUpstream(endpoint, incoming);
    console.log(`[WMS] tentando ${upstream.protocol}//${upstream.host}${upstream.pathname}`);
    try {
      const image = await requestBuffer(upstream);
      preferredEndpointByHost.set(target.hostname.toLowerCase(), endpoint.toString());
      console.log(`[WMS] sucesso ${image.endpoint}`);
      return image;
    } catch (error) {
      const message = `${upstream.protocol}//${upstream.host}${upstream.pathname}: ${error.message}`;
      attempts.push(message);
      console.error(`[WMS] falha ${message}`);
    }
  }
  const error = new Error('Nenhum endpoint WMS entregou imagem válida.');
  error.attempts = attempts;
  throw error;
}

function cacheKey(target, incoming) {
  const params = [...incoming.entries()]
    .filter(([key]) => key.toLowerCase() !== 'target')
    .sort(([a], [b]) => a.localeCompare(b));
  return `${target}|${params.map(([key, value]) => `${key}=${value}`).join('&')}`;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

async function handleWms(req, res, requestUrl) {
  let target;
  try { target = normalizeTarget(requestUrl.searchParams.get('target')); }
  catch (error) {
    return json(req, res, /não autorizado/i.test(error.message) ? 403 : 400, { ok: false, error: error.message });
  }

  pruneCache();
  const key = cacheKey(target, requestUrl.searchParams);
  const cached = cache.get(key);
  if (cached?.expiresAt > Date.now()) return sendImage(req, res, cached, 'HIT');

  let task = inFlight.get(key);
  if (!task) {
    task = fetchFirst(target, requestUrl.searchParams)
      .then((image) => {
        const entry = { ...image, expiresAt: Date.now() + CACHE_TTL_MS };
        cache.set(key, entry);
        return entry;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }

  try {
    const image = await task;
    sendImage(req, res, image, 'MISS');
  } catch (error) {
    json(req, res, 502, {
      ok: false,
      error: 'O proxy Azure BR não conseguiu obter a imagem WMS.',
      details: {
        target: target.toString(),
        layerName: requestUrl.searchParams.get('LAYERS') || requestUrl.searchParams.get('layers') || '',
        attempts: error.attempts || [error.message]
      }
    });
  }
}

function sendImage(req, res, image, cacheStatus) {
  const headers = {
    ...baseHeaders(req),
    'Content-Type': image.contentType,
    'Content-Length': String(image.body.length),
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
    'X-GeoRural-Proxy': 'azure-br',
    'X-GeoRural-Cache': cacheStatus,
    'X-GeoRural-Upstream': image.endpoint
  };
  if (image.etag) headers.ETag = image.etag;
  if (image.lastModified) headers['Last-Modified'] = image.lastModified;
  res.writeHead(200, headers);
  res.end(image.body);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, baseHeaders(req));
    return res.end();
  }

  if (req.method !== 'GET') {
    return json(req, res, 405, { ok: false, error: 'Método não permitido.' });
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/health') {
    return json(req, res, 200, {
      ok: true,
      service: 'GeoRural WMS Proxy Azure BR',
      version: '1.0.0',
      host: HOST,
      port: PORT,
      cacheEntries: cache.size,
      allowedHosts: [...ALLOWED_HOSTS]
    });
  }

  if (requestUrl.pathname === '/api/geoservices/wms') {
    return handleWms(req, res, requestUrl);
  }

  return json(req, res, 404, { ok: false, error: 'Rota não encontrada.' });
});

server.listen(PORT, HOST, () => {
  console.log(`GeoRural WMS Proxy Azure BR ativo em http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`Recebido ${signal}. Encerrando...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
