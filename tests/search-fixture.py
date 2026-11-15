"""Deterministic stdin worker used by native-search.mjs, never shipped as runtime."""
import json
import os
import sys

request = json.load(sys.stdin)
query = request["query"]
if query == "bad json":
    print("not JSON")
elif query == "engine failure":
    print(json.dumps({"error": "Fixture blocked"}))
elif query == "oversized":
    print("x" * 210000)
else:
    assert "TAVILY_API_KEY" not in os.environ
    assert "GITHUB_TOKEN" not in os.environ
    print(json.dumps({"results": [
        {"title": query, "url": "https://docs.python.org/3/library/pathlib.html", "snippet": "paths"},
        {"title": "invalid", "url": "javascript:alert(1)", "snippet": "bad"},
        {"title": "offsite", "url": "https://example.com", "snippet": "other"},
    ]}))
