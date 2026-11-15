"""One-shot local search worker. No web server, API keys, peer network or shell."""
import json
import logging
import sys
import time
from urllib.parse import urlsplit

logging.disable(logging.CRITICAL)


def search_request(request, factory=None):
    if factory is None:
        from ddgs import DDGS
        factory = DDGS
    query = request.get("query", "")
    if not isinstance(query, str) or not 3 <= len(query.strip()) <= 400:
        raise ValueError("Search query must contain 3-400 characters.")
    count = max(1, min(int(request.get("max", 5)), 10))
    sites = request.get("sites", [])
    if not isinstance(sites, list) or len(sites) > 20:
        raise ValueError("Invalid documentation domains.")
    for domain in sites:
        if not isinstance(domain, str) or not domain or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in domain):
            raise ValueError("Invalid documentation domain.")
    # Search engines may ignore a site operator. Enforce domains again on returned URLs.
    text = query.strip()
    if sites:
        text += " (" + " OR ".join("site:" + s for s in sites) + ")"
    region = "ru-ru" if any("\u0400" <= c <= "\u04ff" for c in text) else "us-en"
    results, seen = [], set()
    started = time.monotonic()
    # Explicit engines: never enable a distributed cache or a peer-to-peer service.
    for backend in ("duckduckgo", "brave", "bing", "google"):
        if time.monotonic() - started > 27:
            break
        try:
            rows = factory(timeout=6, verify=True).text(
                text, max_results=max(10, count), region=region,
                safesearch="moderate", backend=backend,
            )
            for row in rows:
                url = row.get("href", "")
                try:
                    parsed = urlsplit(url)
                    host = (parsed.hostname or "").lower()
                    if parsed.scheme not in ("http", "https") or not host or parsed.username or parsed.password:
                        continue
                    if sites and not any(host == s or host.endswith("." + s) for s in sites):
                        continue
                except (ValueError, TypeError):
                    continue
                if url in seen:
                    continue
                seen.add(url)
                results.append({
                    "title": str(row.get("title") or host)[:300],
                    "url": url, "snippet": str(row.get("body") or "")[:600],
                })
            if len(results) >= count:
                break
        except Exception:
            # Do not print provider exceptions: they may echo the query or proxy settings.
            continue
    if not results:
        return {"results": [], "error": "No usable search results. The engines may be blocked, rate-limited, offline, or have no matches. Try a simpler query later."}
    return {"results": results[:count]}


if __name__ == "__main__":
    try:
        if hasattr(sys.stdin, "reconfigure"):
            sys.stdin.reconfigure(encoding="utf-8")
            sys.stdout.reconfigure(encoding="utf-8")
        raw = sys.stdin.read(8193)
        if len(raw) > 8192:
            raise ValueError("Search request too large.")
        print(json.dumps(search_request(json.loads(raw)), ensure_ascii=False))
    except ImportError:
        print(json.dumps({"error": "Built-in search dependency is missing. Restart Relay to repair it automatically."}))
        sys.exit(1)
    except Exception:
        print(json.dumps({"error": "Built-in search could not process the request."}))
        sys.exit(1)
