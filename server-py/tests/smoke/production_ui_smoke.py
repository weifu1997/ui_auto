#!/usr/bin/env python3
"""Python production static-host smoke matching server/production-ui-smoke.ts."""

from __future__ import annotations

import json
import re
import sys
import urllib.request


def run(base_url: str) -> None:
    with urllib.request.urlopen(f"{base_url}/", timeout=10) as response:
        assert response.status == 200
        html = response.read().decode("utf-8")
        assert "id=\"root\"" in html or "<div id=\"root\"></div>" in html
        assert response.headers.get("cache-control") == "no-cache"

    with urllib.request.urlopen(f"{base_url}/ready", timeout=10) as response:
        assert json.loads(response.read().decode("utf-8"))["ready"] is True

    asset = re.search(r"assets/[^\"']+\.js", html)
    if asset:
        with urllib.request.urlopen(f"{base_url}/{asset.group(0)}", timeout=10) as response:
            assert response.status == 200
            assert response.headers.get("cache-control") == "public, max-age=31536000, immutable"
    print("production ui smoke ok")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: production_ui_smoke.py <base-url>")
    run(sys.argv[1])
