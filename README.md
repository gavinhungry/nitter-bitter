nitter-bitter
=============

A small Node.js redirector that sends visitors to the highest-ranked suitable
public Nitter instance reported by [status.d420.de](https://status.d420.de/).
RSS paths are sent only to instances that advertise RSS support.

Cache behavior
--------------

- The cache exists only in process memory; the service never writes it to disk.
- A one-off status API request starts when the process starts.
- Cached data is fresh for 15 minutes.
- Each successful status refresh probes at most three unique instance
  `/.health` endpoints: the top general candidate, the top RSS candidate, and
  the next highest-ranked candidate.
- A reported healthy-session ratio adjusts that instance's status score. A
  blocked, failed, or unrecognized health response leaves its score unchanged.
- There is no refresh timer. The first request after expiry waits for a refresh.
- Concurrent requests share the same in-flight API request.
- If a refresh fails, stale data remains available and another attempt is
  suppressed for 5 minutes.
- If no cache has ever been populated, an API failure results in HTTP 503.

The status API itself updates every 15 minutes. Public Nitter instances should
be used for interactive browsing, not scraping.

`GET /healthz` returns HTTP 200 when the cache contains a suitable instance,
or HTTP 503 otherwise. Like redirect requests, it may trigger and wait for a
stale cache refresh.

License
-------
This software is released under the terms of the **MIT license**. See `LICENSE`.
