import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '17331', 10);

const DEFAULT_STATUS_API_URL = 'https://status.d420.de/api/v1/instances';
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 10 * 1000;
const DEFAULT_HEALTH_FETCH_TIMEOUT_MS = 5 * 1000;
const MAX_HEALTH_PROBES = 3;
const HEALTH_FACTOR = Symbol('healthFactor');

const instanceUrlFor = host => {
  try {
    const url = new URL(host.url);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    ) {
      return url;
    }
  } catch {
    // Ignore malformed instance URLs from the upstream response.
  }

  return null;
};

const isSuitable = (host, needsRss) =>
  host &&
  host.healthy === true &&
  host.is_bad_host !== true &&
  (!needsRss || host.rss === true);

const instanceFor = (hosts, needsRss) => {
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const host of hosts) {
    if (!isSuitable(host, needsRss)) continue;

    const url = instanceUrlFor(host);
    if (!url) continue;

    const points = Number.isFinite(host.points) ? host.points : 0;
    const score = points * (host[HEALTH_FACTOR] ?? 1);
    if (score > bestScore) {
      best = url;
      bestScore = score;
    }
  }

  return best;
};

const healthFactorFor = payload => {
  const sessions = payload?.sessions;
  if (!sessions || typeof sessions !== 'object') return null;

  const total = sessions.total;
  const healthy = sessions.healthy;
  const checked = sessions.checked;
  if (
    Number.isFinite(healthy) &&
    healthy >= 0 &&
    Number.isFinite(checked) &&
    checked >= 0
  ) {
    return checked === 0 ? 0 : Math.min(1, healthy / checked);
  }

  const limited = sessions.limited;
  if (
    Number.isFinite(total) &&
    total >= 0 &&
    Number.isFinite(limited) &&
    limited >= 0
  ) {
    return total === 0 ? 0 : Math.max(0, Math.min(1, (total - limited) / total));
  }

  return null;
};

const healthProbeCandidates = hosts => {
  const candidates = [];
  const add = host => {
    if (host && !candidates.includes(host) && instanceUrlFor(host)) {
      candidates.push(host);
    }
  };

  add(hosts.find(host => isSuitable(host, false)));
  add(hosts.find(host => isSuitable(host, true)));

  for (const host of hosts) {
    if (candidates.length >= MAX_HEALTH_PROBES) break;
    if (isSuitable(host, false)) add(host);
  }

  return candidates.slice(0, MAX_HEALTH_PROBES);
};

const sendText = (response, statusCode, body, headers = {}) => {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  });
  response.end(body);
};

export const createProxy = ({
  fetchImpl = globalThis.fetch,
  statusApiUrl = DEFAULT_STATUS_API_URL,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  healthFetchTimeoutMs = DEFAULT_HEALTH_FETCH_TIMEOUT_MS,
  now = Date.now,
  logger = console,
} = {}) => {
  let snapshot = null;
  let retryAfter = 0;
  let refreshPromise = null;

  const refresh = async () => {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        const response = await fetchImpl(statusApiUrl, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'nitter-bitter/1.0',
          },
          signal: AbortSignal.timeout(fetchTimeoutMs),
        });

        if (!response.ok) {
          throw new Error(`status API returned HTTP ${response.status}`);
        }

        const payload = await response.json();
        if (!payload || !Array.isArray(payload.hosts)) {
          throw new Error('status API response does not contain a hosts array');
        }

        const factors = new Map();
        await Promise.all(
          healthProbeCandidates(payload.hosts).map(async host => {
            try {
              const healthUrl = new URL('/.health', instanceUrlFor(host));
              const healthResponse = await fetchImpl(healthUrl, {
                headers: {
                  Accept: 'application/json',
                  'User-Agent': 'nitter-bitter/1.0',
                },
                signal: AbortSignal.timeout(healthFetchTimeoutMs),
              });
              if (!healthResponse.ok) return;

              const factor = healthFactorFor(await healthResponse.json());
              if (factor !== null) factors.set(host, factor);
            } catch {
              // Instances without an accessible health endpoint remain unpenalized.
            }
          }),
        );

        const hosts = payload.hosts.map(host => {
          const factor = factors.get(host);
          if (factor === undefined) return host;
          return { ...host, [HEALTH_FACTOR]: factor };
        });

        snapshot = {
          hosts,
          fetchedAt: now(),
          lastUpdate:
            typeof payload.last_update === 'string' ? payload.last_update : null,
        };
        retryAfter = 0;
        return snapshot;
      } catch (error) {
        retryAfter = now() + retryDelayMs;
        logger.error('Failed to refresh Nitter instance cache:', error);
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  };

  const currentSnapshot = async () => {
    const currentTime = now();
    const isFresh =
      snapshot && currentTime - snapshot.fetchedAt < cacheTtlMs;

    if (!isFresh && currentTime >= retryAfter) {
      try {
        await refresh();
      } catch {
        // A stale snapshot is preferable to failing the redirect.
      }
    } else if (refreshPromise) {
      try {
        await refreshPromise;
      } catch {
        // The existing snapshot, if any, remains usable.
      }
    }

    return snapshot;
  };

  const handler = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
      return;
    }

    const requestTarget = request.url || '/';
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
      sendText(response, 400, 'Invalid request target\n');
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(requestTarget, 'http://localhost');
      if (requestUrl.origin !== 'http://localhost') {
        throw new Error('request target changed origin');
      }
    } catch {
      sendText(response, 400, 'Invalid request target\n');
      return;
    }

    const cache = await currentSnapshot();
    const hosts = cache?.hosts ?? [];

    if (requestUrl.pathname === '/healthz') {
      const ready = instanceFor(hosts, false) !== null;
      const body = JSON.stringify({
        ready,
        cached: cache !== null,
        lastUpdate: cache?.lastUpdate ?? null,
      });
      response.writeHead(ready ? 200 : 503, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(`${body}\n`);
      return;
    }

    const needsRss = requestUrl.pathname.endsWith('/rss');
    const instance = instanceFor(hosts, needsRss);
    if (!instance) {
      const retrySeconds = Math.max(1, Math.ceil((retryAfter - now()) / 1000));
      sendText(response, 503, 'No suitable Nitter instance is available\n', {
        'Retry-After': String(retrySeconds),
      });
      return;
    }

    const destination = new URL(requestTarget, instance);
    if (destination.origin !== instance.origin) {
      sendText(response, 400, 'Invalid request target\n');
      return;
    }

    response.writeHead(302, {
      'Cache-Control': 'no-store',
      Location: destination.href,
    });
    response.end();
  };

  const server = createServer((request, response) => {
    handler(request, response).catch(error => {
      logger.error('Unhandled request error:', error);
      if (!response.headersSent) {
        sendText(response, 500, 'Internal server error\n');
      } else {
        response.destroy();
      }
    });
  });

  return { server, warmup: refresh };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, warmup } = createProxy();

  server.listen(PORT, HOST, () => {
    console.log(`nitter-bitter listening on http://${HOST}:${PORT}`);
  });

  // Requests arriving during warmup share this same in-flight API call.
  void warmup().catch(() => {});

  const shutdown = () => {
    server.close(error => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
