"""Controlled first-super-admin bootstrap command.

Run through ``npm run bootstrap:super-admin -- --email admin@example.test`` or
directly with ``python -m autoflow.bootstrap_super_admin``. Passwords are read
from the terminal by default and are never accepted as command-line arguments.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from typing import Sequence

from .http import PlatformError
from .services import PlatformServices


def _password_from_stdin() -> str:
    raw = sys.stdin.buffer.readline()
    if not raw:
        raise ValueError("BOOTSTRAP_PASSWORD_REQUIRED")
    return raw.decode("utf-8").rstrip("\r\n")


def _prompt_password() -> str:
    password = getpass.getpass("Set first super-admin password: ")
    confirmation = getpass.getpass("Confirm first super-admin password: ")
    if password != confirmation:
        raise ValueError("BOOTSTRAP_PASSWORD_CONFIRMATION_MISMATCH")
    return password


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create or promote the first AutoFlow deployment super-admin."
    )
    parser.add_argument("--email", required=True, help="Local account email")
    parser.add_argument("--name", help="Display name for a newly created account")
    parser.add_argument(
        "--data-directory",
        default=os.environ.get("PLATFORM_DATA_DIRECTORY", "server/.data"),
        help="Platform data directory (defaults to PLATFORM_DATA_DIRECTORY)",
    )
    parser.add_argument(
        "--password-stdin",
        action="store_true",
        help="Read a single password line from stdin for non-interactive deployment automation",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        password = _password_from_stdin() if args.password_stdin else _prompt_password()
    except (UnicodeDecodeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2

    services = PlatformServices(args.data_directory)
    try:
        user = services.bootstrap_super_admin(args.email, args.name, password)
    except PlatformError as error:
        print(error.code, file=sys.stderr)
        return 2
    finally:
        services.close()
    print(f"Super-admin bootstrap complete for account {user.id}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
