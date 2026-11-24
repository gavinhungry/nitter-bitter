import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '17331', 10);

const DEFAULT_STATUS_API_URL = 'https://status.d420.de/api/v1/instances';
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 10 * 1000;
const DEFAULT_HEALTH_FETCH_TIMEOUT_MS = 5 * 1000;
const DEFAULT_EXCLUDE_HOSTS = (process.env.EXCLUDE_HOSTS || '').split(',');
const DEFAULT_CLIENT_PROBE = /^(1|true)$/i.test((process.env.CLIENT_PROBE || '').trim());
const HEALTH_PROBE_BATCH_SIZE = 3;
const MAX_HEALTH_PROBES = 8;
const CLIENT_SHORTLIST_SIZE = 8;
const CLIENT_PROBE_TIMEOUT_MS = 2500;
const HEALTH_FACTOR = Symbol('healthFactor');
const PROBE_RESULT = Symbol('probeResult');
const REACHABLE = 'reachable';
const UNREACHABLE = 'unreachable';

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

const rankedInstances = (hosts, needsRss, allowUnreachable) => {
  const ranked = [];

  hosts.forEach((host, index) => {
    if (!isSuitable(host, needsRss)) return;
    if (!allowUnreachable && host[PROBE_RESULT] === UNREACHABLE) return;

    const url = instanceUrlFor(host);
    if (!url) return;

    const points = Number.isFinite(host.points) ? host.points : 0;
    const score = points * (host[HEALTH_FACTOR] ?? 1);
    ranked.push({ url, score, index });
  });

  // Ties keep the status API's order.
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.map(entry => entry.url);
};

// If every suitable instance failed its probe, fall back to ranking them anyway.
const instancesFor = (hosts, needsRss) => {
  const reachable = rankedInstances(hosts, needsRss, false);
  return reachable.length > 0 ? reachable : rankedInstances(hosts, needsRss, true);
};

const instanceFor = (hosts, needsRss) => instancesFor(hosts, needsRss)[0] ?? null;

const hasReachableInstance = hosts =>
  hosts.some(host => isSuitable(host, false) && host[PROBE_RESULT] === REACHABLE);

const normalizeExcludedHosts = hosts =>
  new Set(
    hosts.map(host => String(host).trim().toLowerCase()).filter(Boolean),
  );

const isOutdated = host => host?.version_state === 'Outdated';

const isExcluded = (host, excludedHosts) => {
  const url = instanceUrlFor(host);
  return url !== null && excludedHosts.has(url.hostname);
};

// Accepts delta-seconds or an HTTP date. Returns null when absent or invalid.
const retryAfterMsFor = (value, currentTime) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - currentTime) : null;
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

const nextProbeBatch = (hosts, probed, needsWeb, needsRss, limit) => {
  const batch = [];
  const isCandidate = (host, needsRssSupport) =>
    !probed.has(host) &&
    !batch.includes(host) &&
    isSuitable(host, needsRssSupport) &&
    instanceUrlFor(host) !== null;
  const add = host => {
    if (host && batch.length < limit) batch.push(host);
  };

  if (needsWeb) add(hosts.find(host => isCandidate(host, false)));
  if (needsRss) add(hosts.find(host => isCandidate(host, true)));

  for (const host of hosts) {
    if (batch.length >= limit) break;
    if (isCandidate(host, !needsWeb)) add(host);
  }

  return batch;
};

// Runs in the browser as well as in tests, so it must not reference module scope.
// Probes candidates in ranked batches and resolves with the highest-ranked
// candidate that answered, or null if none did. `probe` must never reject.
export async function pickCandidate(candidates, probe, batchSize) {
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const winner = await new Promise(resolve => {
      const results = batch.map(() => undefined);
      const settle = () => {
        for (let i = 0; i < batch.length; i++) {
          // A higher-ranked candidate is still pending.
          if (results[i] === undefined) return;
          if (results[i]) return resolve(batch[i]);
        }
        resolve(null);
      };
      batch.forEach((candidate, i) => {
        probe(candidate).then(ok => {
          results[i] = ok === true;
          settle();
        });
      });
    });
    if (winner) return winner;
  }
  return null;
}

const CLIENT_DATA_ID = 'nitter-bitter-candidates';

const CLIENT_SCRIPT = `(async () => {
  const pickCandidate = ${pickCandidate};
  const data = JSON.parse(document.getElementById('${CLIENT_DATA_ID}').textContent);
  const probe = candidate =>
    fetch(candidate.origin + '/.health', {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(data.timeoutMs),
    }).then(() => true, () => false);

  const pick = await pickCandidate(data.candidates, probe, data.batchSize);
  if (pick) {
    location.replace(pick.href);
    return;
  }

  const message = document.createElement('p');
  message.textContent = 'No Nitter instance responded. Try one of these:';
  const list = document.createElement('ul');
  for (const candidate of data.candidates) {
    const link = document.createElement('a');
    link.href = candidate.href;
    link.textContent = candidate.origin;
    const item = document.createElement('li');
    item.append(link);
    list.append(item);
  }
  document.body.append(message, list);
})();`;

const CLIENT_SCRIPT_HASH = createHash('sha256').update(CLIENT_SCRIPT).digest('base64');

const CLIENT_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${CLIENT_SCRIPT_HASH}'`,
  'connect-src https:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const escapeHtml = value =>
  String(value).replace(
    /[&<>"']/g,
    char => `&#${char.charCodeAt(0)};`,
  );

// Safe inside a <script> element: no "</script", "<!--", or line separators.
const jsonForScript = value =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

const clientPage = candidates => {
  const fallback = escapeHtml(candidates[0].href);
  const data = jsonForScript({
    candidates,
    batchSize: HEALTH_PROBE_BATCH_SIZE,
    timeoutMs: CLIENT_PROBE_TIMEOUT_MS,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nitter</title>
<noscript><meta http-equiv="refresh" content="0;url=${fallback}"></noscript>
</head>
<body>
<noscript><a href="${fallback}">Continue to Nitter</a></noscript>
<script type="application/json" id="${CLIENT_DATA_ID}">${data}</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
};

const wantsHtml = request =>
  (request.headers.accept || '').toLowerCase().includes('text/html');

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
  maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  healthFetchTimeoutMs = DEFAULT_HEALTH_FETCH_TIMEOUT_MS,
  excludeHosts = DEFAULT_EXCLUDE_HOSTS,
  clientProbe = DEFAULT_CLIENT_PROBE,
  now = Date.now,
  logger = console,
} = {}) => {
  const excludedHosts = normalizeExcludedHosts(excludeHosts);
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
          const error = new Error(`status API returned HTTP ${response.status}`);
          if (response.status === 429 || response.status === 503) {
            error.retryAfterMs = retryAfterMsFor(
              response.headers.get('retry-after'),
              now(),
            );
          }
          throw error;
        }

        const payload = await response.json();
        if (!payload || !Array.isArray(payload.hosts)) {
          throw new Error('status API response does not contain a hosts array');
        }

        const candidates = payload.hosts.filter(
          host => !isExcluded(host, excludedHosts) && !isOutdated(host),
        );

        const probe = async host => {
          let healthResponse;
          try {
            healthResponse = await fetchImpl(
              new URL('/.health', instanceUrlFor(host)),
              {
                headers: {
                  Accept: 'application/json',
                  'User-Agent': 'nitter-bitter/1.0',
                },
                signal: AbortSignal.timeout(healthFetchTimeoutMs),
              },
            );
          } catch {
            // Timeouts, refused connections, and DNS or TLS failures.
            return { result: UNREACHABLE };
          }

          try {
            if (!healthResponse.ok) return { result: REACHABLE };
            const factor = healthFactorFor(await healthResponse.json());
            return { result: REACHABLE, factor };
          } catch {
            // Instances without an accessible health endpoint remain unpenalized.
            return { result: REACHABLE };
          }
        };

        const probes = new Map();
        const hasProbedReachable = needsRss =>
          [...probes].some(
            ([host, { result }]) =>
              result === REACHABLE && isSuitable(host, needsRss),
          );

        while (probes.size < MAX_HEALTH_PROBES) {
          const needsWeb = !hasProbedReachable(false);
          const needsRss = !hasProbedReachable(true);
          if (!needsWeb && !needsRss) break;

          const batch = nextProbeBatch(
            candidates,
            probes,
            needsWeb,
            needsRss,
            Math.min(HEALTH_PROBE_BATCH_SIZE, MAX_HEALTH_PROBES - probes.size),
          );
          if (batch.length === 0) break;

          const results = await Promise.all(batch.map(probe));
          batch.forEach((host, index) => probes.set(host, results[index]));
        }

        const hosts = candidates.map(host => {
          const probeResult = probes.get(host);
          if (!probeResult) return host;
          return {
            ...host,
            [PROBE_RESULT]: probeResult.result,
            ...(Number.isFinite(probeResult.factor) && {
              [HEALTH_FACTOR]: probeResult.factor,
            }),
          };
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
        // Never retry sooner than usual; honor longer upstream requests up to a cap.
        const delayMs = Math.max(
          retryDelayMs,
          Math.min(error.retryAfterMs ?? 0, maxRetryAfterMs),
        );
        retryAfter = now() + delayMs;
        logger.error(
          `Failed to refresh Nitter instance cache (retrying in ${Math.ceil(delayMs / 1000)}s):`,
          error,
        );
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
      const web = instanceFor(hosts, false);
      const rss = instanceFor(hosts, true);
      const ready = web !== null;
      const body = JSON.stringify({
        ready,
        reachable: hasReachableInstance(hosts),
        cached: cache !== null,
        lastUpdate: cache?.lastUpdate ?? null,
        upstream: {
          web: web?.origin ?? null,
          rss: rss?.origin ?? null,
        },
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

    if (clientProbe && !needsRss && wantsHtml(request)) {
      const candidates = [];
      for (const url of instancesFor(hosts, false)) {
        if (candidates.length >= CLIENT_SHORTLIST_SIZE) break;
        if (candidates.some(candidate => candidate.origin === url.origin)) continue;

        const href = new URL(requestTarget, url);
        if (href.origin !== url.origin) continue;
        candidates.push({ origin: url.origin, href: href.href });
      }

      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': CLIENT_CSP,
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(clientPage(candidates));
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
