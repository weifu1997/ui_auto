#!/usr/bin/env python3
"""Re-encrypt all stored secrets onto the active master key (P2-2).

Rotation procedure for ``project_secrets``, webhook signing secrets, and
notification-channel configs:

1. Prepare env for the NEW active key plus the OLD key(s) for dual-read:
     export PLATFORM_SECRET_KEY='<new active key>'
     export PLATFORM_SECRET_KEY_VERSION=2            # stable id of the new key
     export PLATFORM_SECRET_KEY_VERSIONS='{"1":"<old key that encrypted v1 rows>"}'
   Start the service once so it can still decrypt old rows (dual-read).
2. Run this tool (service may stay up; writes are in one transaction):
     python scripts/ops/reencrypt-secrets.py --data-dir <dir> [--dry-run]
   Every row is rewritten with the active key and stamped ``v<active>.``.
3. Now the old key is no longer needed to decrypt; you may drop
   ``PLATFORM_SECRET_KEY_VERSIONS`` (keep ``PLATFORM_SECRET_KEY_VERSION``).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Autoflow lives under <repo>/server-py; this script sits in <repo>/scripts/ops.
_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT / "server-py"))

from autoflow.services import PlatformServices  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        default=os.environ.get(
            "PLATFORM_DATA_DIRECTORY", str(_REPO_ROOT / "data")
        ),
        help="Platform data directory (PLATFORM_DATA_DIRECTORY)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report which rows would be rewritten without writing.",
    )
    args = parser.parse_args()

    services = PlatformServices(args.data_dir)
    try:
        counts = services.reencrypt_secrets_to_active_master_key(
            dry_run=args.dry_run
        )
    finally:
        services.close()

    verb = "would rewrite" if args.dry_run else "rewrote"
    for store, count in counts.items():
        print(f"{store}: {verb} {count} row(s)")
    if not args.dry_run:
        print(
            f"active master-key version: {services.active_secret_version} — "
            "old PLATFORM_SECRET_KEY_VERSIONS entries are no longer needed"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
