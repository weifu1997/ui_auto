"""P1-1: outbound browser URL guard — no link-local / cloud-metadata targets.

Bug under test (audit P1-1): browser navigation is already confined to the
environment ``baseUrl`` origin (``runner._target_url`` enforces same-origin),
but ``baseUrl`` itself is a member-controlled value that may point at
link-local / cloud-metadata space. A run / element validation / recording
session / preview would then happily steer the runner's headed browser at
``http://169.254.169.254/latest/meta-data/...`` and read instance IAM
credentials from the deployment box — SSRF through the environment.

Fix contract (user-approved, low-risk scope):
- Block link-local IPv4 (169.254.0.0/16 — includes cloud metadata
  169.254.169.254) and IPv6 link-local (fe80::/10) hosts, plus the two
  well-known metadata FQDNs, wherever a browser would be pointed at a URL.
- Do NOT blanket-block loopback / RFC1918 private space: deployments run
  automation against 127.0.0.1 / LAN apps (recorder against a local demo),
  so those stay allowed.

Guarded chokepoints:
- ``autoflow.runner._target_url`` — every page.goto in real/batch/preview runs.
- ``autoflow.recorder_validation.recording_target_url`` — recording start.
- ``ValidationServices.require_same_origin_element_path`` — element validation.
- ``preview_run`` (``services/runs/_lifecycle.py``) — fails before launching a
  browser for a caller-supplied ``environment.baseUrl``.
"""

import pytest

import autoflow.runner as _runner
from autoflow.http import PlatformError
from autoflow.recorder_validation import recording_target_url
from autoflow.services import PlatformServices, ValidationServices

# hosts that MUST be rejected as browser navigation targets
BLOCKED_BASES = [
    "http://169.254.169.254/latest/meta-data/",  # cloud metadata (AWS/GCP/Azure)
    "http://169.254.0.1/",  # link-local auto-config range
    "http://[fe80::1]:8080/",  # IPv6 link-local
    "http://metadata.google.internal/",  # GCP metadata FQDN
]

# hosts that MUST stay allowed (loopback / LAN / public) — guard against
# over-blocking; the recorder and run e2e target 127.0.0.1 / localhost.
ALLOWED_BASES = [
    "http://127.0.0.1:8787/app",
    "http://localhost:8787/",
    "http://192.168.1.50/ui",
    "http://10.1.2.3/",
    "https://app.test/base/",
    "https://intranet.corp/x",
]


# --------------------------------------------------------------------------- #
# runner._target_url — the single navigation chokepoint for real/preview/batch
# --------------------------------------------------------------------------- #

def test_target_url_rejects_link_local_and_metadata_bases():
    for base in BLOCKED_BASES:
        with pytest.raises(RuntimeError) as exc:
            _runner._target_url(base, "/")  # noqa: SLF001
        assert "TARGET_URL_LINK_LOCAL_FORBIDDEN" in str(exc.value)


def test_target_url_allows_loopback_lan_and_public_bases():
    for base in ALLOWED_BASES:
        resolved = _runner._target_url(base, "/")
        assert resolved.startswith(("http://", "https://"))


def test_target_url_still_forbids_cross_origin_value():
    # absolute value on a *different* host stays forbidden even if that host is
    # private; origin confinement is unchanged.
    with pytest.raises(RuntimeError) as exc:
        _runner._target_url("https://app.test", "http://169.254.169.254/latest")
    assert "TARGET_URL_ORIGIN_FORBIDDEN" in str(exc.value)


# --------------------------------------------------------------------------- #
# recording_target_url — recording session start navigates the browser
# --------------------------------------------------------------------------- #

def test_recording_target_url_rejects_link_local_base():
    for base in BLOCKED_BASES:
        with pytest.raises(PlatformError) as exc:
            recording_target_url(base, "/login")
        assert exc.value.code == "RECORDING_ENVIRONMENT_INVALID"


def test_recording_target_url_allows_loopback_base():
    # the recorder e2e records against a local demo app on 127.0.0.1
    assert recording_target_url("http://127.0.0.1:8787/", "/login") == (
        "http://127.0.0.1:8787/login"
    )


def test_recording_target_url_still_forbids_cross_origin():
    with pytest.raises(PlatformError) as exc:
        recording_target_url("https://app.test", "https://other.test/x")
    assert exc.value.code == "RECORDING_START_URL_INVALID"


# --------------------------------------------------------------------------- #
# require_same_origin_element_path — element validation navigation
# --------------------------------------------------------------------------- #

def _validation_services() -> ValidationServices:
    return object.__new__(ValidationServices)


def test_element_validation_rejects_link_local_base():
    services = _validation_services()
    for base in BLOCKED_BASES:
        with pytest.raises(PlatformError) as exc:
            services.require_same_origin_element_path(
                {"baseUrl": base}, {"path": "/"}
            )
        assert exc.value.code == "ELEMENT_VALIDATION_TARGET_FORBIDDEN"


def test_element_validation_allows_loopback_base():
    services = _validation_services()
    services.require_same_origin_element_path(
        {"baseUrl": "http://127.0.0.1:8787/"}, {"path": "/login"}
    )  # no raise


def test_element_validation_still_forbids_cross_origin():
    services = _validation_services()
    with pytest.raises(PlatformError) as exc:
        services.require_same_origin_element_path(
            {"baseUrl": "https://app.test/"}, {"path": "https://other.test/x"}
        )
    assert exc.value.code == "ELEMENT_VALIDATION_TARGET_FORBIDDEN"


# --------------------------------------------------------------------------- #
# preview_run — caller supplies environment.baseUrl; must reject before the
# runner launches any browser (fix puts the check before execute_browser_run).
# --------------------------------------------------------------------------- #

def test_preview_run_rejects_link_local_environment(tmp_path, monkeypatch):
    services = PlatformServices(str(tmp_path))
    try:
        def _stub_execute(*_args, **_kwargs):
            raise AssertionError("browser must not launch for a blocked baseUrl")

        monkeypatch.setattr(_runner, "execute_browser_run", _stub_execute)
        for base in BLOCKED_BASES:
            with pytest.raises(PlatformError) as exc:
                services.preview_run(
                    "proj-any",
                    {
                        "environment": {"baseUrl": base},
                        "flow": {
                            "id": "f1",
                            "name": "preview",
                            "steps": [
                                {
                                    "id": "s1",
                                    "title": "open",
                                    "action": "打开页面",
                                    "value": "/",
                                }
                            ],
                        },
                    },
                )
            assert exc.value.code == "PREVIEW_URL_FORBIDDEN"
    finally:
        services.close()


def test_preview_run_allows_loopback_environment(tmp_path, monkeypatch):
    services = PlatformServices(str(tmp_path))
    try:
        def _stub_execute(input_data, _hooks):
            return {"flowOutputs": {}, "steps": []}

        monkeypatch.setattr(_runner, "execute_browser_run", _stub_execute)
        result = services.preview_run(
            "proj-any",
            {
                "environment": {"baseUrl": "http://127.0.0.1:8787/"},
                "flow": {"id": "f1", "name": "preview", "steps": []},
            },
        )
        assert "result" in result
    finally:
        services.close()
