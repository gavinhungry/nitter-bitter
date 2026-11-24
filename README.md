nitter-bitter
=============

A small Node.js redirector that sends visitors to the highest-ranked suitable
public [Nitter](https://github.com/zedeus/nitter) instance reported by
[status.d420.de](https://status.d420.de/). RSS paths are sent only to instances
that advertise RSS support.

Cache behavior
--------------

- The cache exists only in process memory; the service never writes it to disk.
- A one-off status API request starts when the process starts.
- Cached data is fresh for 15 minutes.
- Each successful status refresh probes instance `/.health` endpoints in
  ranked order, in parallel batches of up to three, until it finds a reachable
  web candidate and a reachable RSS candidate. At most eight instances are
  probed per refresh.
- An instance whose probe fails at the network level (timeout, refused
  connection, DNS or TLS error) is skipped until the next refresh. If every
  suitable instance is unreachable, they are ranked as usual instead.
- A reported healthy-session ratio adjusts that instance's status score. A
  blocked, failed, or unrecognized health response leaves its score unchanged.
- There is no refresh timer. The first request after expiry waits for a refresh.
- Concurrent requests share the same in-flight API request.
- If a refresh fails, stale data remains available and another attempt is
  suppressed for 5 minutes.
- If no cache has ever been populated, an API failure results in HTTP 503.

The status API itself updates every 15 minutes. Public Nitter instances should
be used for interactive browsing, not scraping.

Configuration
-------------

- `HOST` and `PORT` set the listen address (default `127.0.0.1:17331`).
- `EXCLUDE_HOSTS` is a comma-separated list of instance hostnames that are
  never used, matched case-insensitively, e.g.
  `EXCLUDE_HOSTS=nitter.example.com,xcancel.com`. Changes require a restart.
- `CLIENT_PROBE=1` (or `true`) enables browser-side instance selection. It is
  off by default.

Browser-side selection
----------------------

When `CLIENT_PROBE` is enabled, requests that accept `text/html` and do not end
in `/rss` receive a small blank page instead of a redirect. The page contains
up to eight ranked web instances, with excluded and server-unreachable
instances removed. Its script probes them from the visitor's own network, in
parallel batches of three with a 2.5-second timeout, and navigates to the
highest-ranked instance that answers. This catches instances that are
unreachable from a visitor's network even when the server can reach them.

- The probes are `no-cors` requests to each instance's `/.health`; any HTTP
  response counts as reachable.
- Nothing is stored in the browser, so every visit probes again.
- Without JavaScript, the page redirects to the server's top pick.
- If no instance answers, the page lists links to all candidates.
- RSS paths and other clients (feed readers, `curl`) always get the redirect.

Health endpoint
---------------

`GET /healthz` returns HTTP 200 when the cache contains a suitable instance,
or HTTP 503 otherwise. Like redirect requests, it may trigger and wait for a
stale cache refresh. The JSON body contains:

- `ready`: whether requests will be redirected (matches the status code).
- `reachable`: whether at least one suitable instance answered its health
  probe during the last refresh. This does not affect the status code.
- `cached`: whether the instance list has ever been fetched.
- `lastUpdate`: the status API's last update time, or `null`.
- `upstream.web` and `upstream.rss`: the instances that web and RSS requests
  are currently sent to, or `null` if there is none. With `CLIENT_PROBE`,
  `upstream.web` is the server's top pick; a browser may choose another.

Run the tests with `node --test`.

License
-------
This software is released under the terms of the **MIT license**. See `LICENSE`.
