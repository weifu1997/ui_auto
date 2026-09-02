"""P2-2: versioned master key + dual-read + re-encryption (RED→GREEN).

Bug under test (audit P2-2): the master key is an unlabelled sha256 of a single
env secret; rotating ``PLATFORM_SECRET_KEY`` makes every stored secret
(project_secrets / webhook signing / notification channel config) fail to
decrypt with ``InvalidTag`` — no "old key" dual-read, no re-encryption path,
and ``project_secrets.key_version`` is mislabelled as a write counter.

Fix contract (user-selected design A, stable-numbering refinement):
- ``PLATFORM_SECRET_KEY`` (or ``_FILE``) stays the ACTIVE key.
- ``PLATFORM_SECRET_KEY_VERSION`` (int, default 1) is the active key's stable
  identity — it must NOT drift when retired keys are pruned after re-encryption.
- ``PLATFORM_SECRET_KEY_VERSIONS`` = JSON ``{"1": "<older key>", ...}`` maps the
  OTHER versions to their keys (for decrypt only).
- Stored ciphertext carries a ``v<version>.`` prefix. Markerless rows are legacy
  and are treated as version 1. Resolution is exact (no trial decrypt): version
  ``== active_version`` -> active key; else ``retired[version]``.
- ``SecretServices.reencrypt_secrets_to_active_master_key()`` rewrites every
  store row to the active key, so the retired keys can then be dropped.
"""

from __future__ import annotations

import asyncio
import json

import pytest

import autoflow.crypto as _crypto
from autoflow.core import now
from autoflow.handler import create_platform_router
from autoflow.services import AuthUser, PlatformServices


# --------------------------------------------------------------------------- #
# setup helpers
# --------------------------------------------------------------------------- #

def _make_services(
    monkeypatch,
    data_path,
    active: str,
    versions: dict[int, str] | None = None,
    active_version: int | None = None,
) -> PlatformServices:
    monkeypatch.setenv("PLATFORM_SECRET_KEY", active)
    monkeypatch.delenv("PLATFORM_SECRET_KEY_FILE", raising=False)
    if versions is None:
        monkeypatch.delenv("PLATFORM_SECRET_KEY_VERSIONS", raising=False)
    else:
        monkeypatch.setenv(
            "PLATFORM_SECRET_KEY_VERSIONS",
            json.dumps({str(key): value for key, value in versions.items()}),
        )
    if active_version is None:
        monkeypatch.delenv("PLATFORM_SECRET_KEY_VERSION", raising=False)
    else:
        monkeypatch.setenv("PLATFORM_SECRET_KEY_VERSION", str(active_version))
    return PlatformServices(str(data_path))


def _bootstrap_project(services) -> str:
    user = AuthUser("mk-user", "mk@example.test", "MK")
    services.database.execute(
        """
        INSERT INTO platform_users (id, email, name, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (user.id, user.email, user.name, now()),
    )
    workspace = services.create_workspace(user, "Key workspace")
    project_id = "proj-1"
    services.database.execute(
        """
        INSERT INTO platform_projects (
          id, workspace_id, slug, name, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (project_id, workspace["id"], project_id, "Project", "", now(), now()),
    )
    return project_id


def _insert_project_secret(
    services, project_id: str, encrypted: dict[str, str], name="token"
) -> None:
    services.database.execute(
        """
        INSERT INTO project_secrets (
          id, project_id, name, key_version, iv, tag, ciphertext,
          created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
        """,
        (
            "sec-1",
            project_id,
            name,
            encrypted["iv"],
            encrypted["tag"],
            encrypted["ciphertext"],
            now(),
            now(),
        ),
    )


def _read_secret_row(services, secret_id="sec-1") -> tuple[str, str, str, int]:
    row = services.database.execute(
        "SELECT iv, tag, ciphertext, key_version FROM project_secrets WHERE id = ?",
        (secret_id,),
    ).fetchone()
    return row[0], row[1], row[2], row[3]


def _workspace_of(services, project_id: str) -> str:
    return services.database.execute(
        "SELECT workspace_id FROM platform_projects WHERE id = ?",
        (project_id,),
    ).fetchone()[0]


# --------------------------------------------------------------------------- #
# crypto helpers: versioned-ciphertext primitives (RED: symbols missing)
# --------------------------------------------------------------------------- #

def test_crypto_legacy_ciphertext_has_no_version():
    raw = "aGVsbG8="  # base64("hello") — cannot collide with a vN. marker
    assert _crypto.ciphertext_version(raw) is None
    assert _crypto.unstamp_ciphertext(raw) == (None, raw)


def test_crypto_stamp_roundtrip_and_active_version_numbering():
    keyring = _crypto.SecretKeyring(active_secret="active")
    assert keyring.active_version == 1
    stamped = keyring.stamp("aGVsbG8=")
    assert stamped == "v1.aGVsbG8="
    assert _crypto.ciphertext_version(stamped) == 1
    assert _crypto.unstamp_ciphertext(stamped) == (1, "aGVsbG8=")

    rotated = _crypto.SecretKeyring(
        active_secret="new", retired={1: "old"}, active_version=2
    )
    assert rotated.active_version == 2
    assert rotated.stamp("aGVsbG8=") == "v2.aGVsbG8="


def test_crypto_keyring_resolves_by_version_and_legacy_means_v1():
    old, new = "key-A" * 4, "key-B" * 4
    encrypted = _crypto.encrypt("needle", old)  # raw crypto, markerless legacy
    rotated = _crypto.SecretKeyring(
        active_secret=new, retired={1: old}, active_version=2
    )
    # markerless legacy row → treated as version 1 → retired key 1
    assert (
        rotated.decrypt_stored(encrypted.iv, encrypted.tag, encrypted.ciphertext)
        == "needle"
    )
    # explicitly version-1 stamped row (content under old) → retired key 1
    assert (
        rotated.decrypt_stored(
            encrypted.iv, encrypted.tag, f"v1.{encrypted.ciphertext}"
        )
        == "needle"
    )
    # fresh row under the active (version 2) key — services.encrypt stamps it
    fresh = _crypto.encrypt("fresh", new)
    assert (
        rotated.decrypt_stored(
            fresh.iv, fresh.tag, rotated.stamp(fresh.ciphertext)
        )
        == "fresh"
    )


def test_crypto_keyring_rejects_unknown_stamped_version():
    rotated = _crypto.SecretKeyring(
        active_secret="new", retired={1: "old"}, active_version=2
    )
    ciphertext = _crypto.encrypt("x", "new")
    with pytest.raises(_crypto.MasterKeyVersionError):
        rotated.decrypt_stored(ciphertext.iv, ciphertext.tag, "v99." + ciphertext.ciphertext)


# --------------------------------------------------------------------------- #
# service-level: rotation must not break decryption (RED: InvalidTag today)
# --------------------------------------------------------------------------- #

def test_rotated_active_key_still_decrypts_old_secret(tmp_path, monkeypatch):
    old, new = "key-A" * 4, "key-B" * 4
    data = tmp_path / "data"
    s1 = _make_services(monkeypatch, data, old)
    try:
        project_id = _bootstrap_project(s1)
        _insert_project_secret(s1, project_id, s1.encrypt("needle-secret"))
    finally:
        s1.close()

    s2 = _make_services(
        monkeypatch, data, new, versions={1: old}, active_version=2
    )
    try:
        iv, tag, ciphertext, _version = _read_secret_row(s2)
        # 修复前：s2 只用 new key 解旧密文 → AESGCM InvalidTag。
        assert s2.decrypt({"iv": iv, "tag": tag, "ciphertext": ciphertext}) == "needle-secret"
        # 修复后新写入也要带当前版本前缀。
        assert s2.encrypt("fresh")["ciphertext"].startswith("v2.")
    finally:
        s2.close()


# --------------------------------------------------------------------------- #
# handler-level: key_version must mean master-key version, not a write counter
# --------------------------------------------------------------------------- #

def test_overwriting_secret_keeps_master_key_version(tmp_path):
    services = PlatformServices(str(tmp_path))
    try:
        router = create_platform_router(services)
        user = AuthUser("mk-http", "mk-http@example.test", "MKH")
        services.database.execute(
            """
            INSERT INTO platform_users (id, email, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, user.email, user.name, now()),
        )
        workspace = services.create_workspace(user, "Key HTTP workspace")
        services.database.execute(
            """
            INSERT INTO platform_projects (
              id, workspace_id, slug, name, description, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "proj-http",
                workspace["id"],
                "proj-http",
                "Project",
                "",
                now(),
                now(),
            ),
        )
        session = services.create_auth_session(user)
        secrets_route = next(
            route
            for route in router.routes
            if getattr(route, "path", None)
            == "/api/platform/projects/{project_id}/secrets"
        )

        async def create_secret(value: str):
            from starlette.requests import Request

            body = json.dumps({"name": "api-token", "value": value}).encode()
            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": "/api/platform/projects/proj-http",
                "raw_path": b"/api/platform/projects/proj-http",
                "query_string": b"",
                "headers": [(b"authorization", f"Bearer {session['token']}".encode())],
                "client": ("127.0.0.1", 1234),
                "server": ("127.0.0.1", 8787),
            }

            async def receive():
                return {"type": "http.request", "body": body, "more_body": False}

            response = await secrets_route.endpoint(
                Request(scope, receive=receive), project_id="proj-http"
            )
            return json.loads(response.body)["secret"]["keyVersion"]

        # 默认单 key 部署：主密钥版本恒为 1；覆盖两次不是“写次数计数”。
        assert asyncio.run(create_secret("v1")) == 1
        assert asyncio.run(create_secret("v2")) == 1  # 修复前返回 2 → RED
        db_version = services.database.execute(
            "SELECT key_version FROM project_secrets WHERE name = ?",
            ("api-token",),
        ).fetchone()[0]
        assert db_version == 1
    finally:
        services.close()


# --------------------------------------------------------------------------- #
# re-encryption ops tool loads (RED: script missing)
# --------------------------------------------------------------------------- #

def test_reencrypt_ops_tool_module_loads():
    import importlib.util
    from pathlib import Path

    script = Path(__file__).resolve().parents[3] / "scripts" / "ops" / "reencrypt-secrets.py"
    assert script.exists()
    spec = importlib.util.spec_from_file_location("reencrypt_secrets_ops", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert callable(module.main)


# --------------------------------------------------------------------------- #
# re-encryption tool path (RED: method does not exist yet)
# --------------------------------------------------------------------------- #

def test_reencrypt_moves_every_secret_store_to_active_key(tmp_path, monkeypatch):
    old, new = "key-A" * 4, "key-B" * 4
    data = tmp_path / "data"
    s1 = _make_services(monkeypatch, data, old)
    try:
        project_id = _bootstrap_project(s1)
        _insert_project_secret(s1, project_id, s1.encrypt("needle-secret"))
        # webhook signing secret
        s1.database.execute(
            """
            INSERT INTO flow_revisions (
              id, project_id, flow_id, flow_name, environment_id,
              revision_number, status, flow_snapshot, environment_snapshot,
              element_snapshot, dataset_snapshot, checksum, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "rev-1",
                project_id,
                "flow-1",
                "Flow",
                "env-1",
                1,
                "published",
                "{}",
                json.dumps({"browser": "Chromium"}),
                "[]",
                "null",
                "checksum",
                "mk-user",
                now(),
            ),
        )
        hook_enc = s1.encrypt("whsec_oldsecret")
        s1.database.execute(
            """
            INSERT INTO webhook_triggers (
              id, project_id, revision_id, environment_id, name,
              signing_secret_iv, signing_secret_tag, signing_secret_ciphertext,
              enabled, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                "hook-1",
                project_id,
                "rev-1",
                "env-1",
                "CI hook",
                hook_enc["iv"],
                hook_enc["tag"],
                hook_enc["ciphertext"],
                "mk-user",
                now(),
            ),
        )
        # notification channel config
        channel_enc = s1.encrypt(json.dumps({"url": "https://example.test/hook"}))
        s1.database.execute(
            """
            INSERT INTO notification_channels (
              id, workspace_id, name, channel_type, config_iv, config_tag,
              config_ciphertext, enabled, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                "chan-1",
                _workspace_of(s1, project_id),
                "Ops",
                "webhook",
                channel_enc["iv"],
                channel_enc["tag"],
                channel_enc["ciphertext"],
                "mk-user",
                now(),
                now(),
            ),
        )
    finally:
        s1.close()

    s2 = _make_services(
        monkeypatch, data, new, versions={1: old}, active_version=2
    )
    try:
        counts = s2.reencrypt_secrets_to_active_master_key()  # 修复前不存在 → RED
        assert counts["projectSecrets"] == 1
        assert counts["webhookSigningSecrets"] == 1
        assert counts["notificationChannelConfigs"] == 1
    finally:
        s2.close()

    # 重加密后旧 key 已不再需要：active_version=2、不带 versions 也能解出全部。
    s3 = _make_services(monkeypatch, data, new, active_version=2)
    try:
        iv, tag, ciphertext, key_version = _read_secret_row(s3)
        assert key_version == 2  # 主密钥版本，而非写次数
        assert s3.decrypt({"iv": iv, "tag": tag, "ciphertext": ciphertext}) == "needle-secret"
        hook = s3.database.execute(
            """
            SELECT signing_secret_iv, signing_secret_tag, signing_secret_ciphertext
            FROM webhook_triggers WHERE id = ?
            """,
            ("hook-1",),
        ).fetchone()
        assert s3.decrypt(
            {"iv": hook[0], "tag": hook[1], "ciphertext": hook[2]}
        ) == "whsec_oldsecret"
        chan = s3.database.execute(
            """
            SELECT config_iv, config_tag, config_ciphertext
            FROM notification_channels WHERE id = ?
            """,
            ("chan-1",),
        ).fetchone()
        assert "example.test" in s3.decrypt(
            {"iv": chan[0], "tag": chan[1], "ciphertext": chan[2]}
        )
    finally:
        s3.close()
