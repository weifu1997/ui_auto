"""Element validation login-wall decision logic.

When validation opens a target page behind a login wall it must surface a
precise, actionable error code instead of a silent "missed":
- no stored login snapshot yet  -> ask the user to record a login first
- a stored snapshot was injected but still shows the login wall -> stale snapshot
- the element itself lives on a login page (e.g. the login button) -> no error
"""

from autoflow.runner import _element_validation_login_error
from autoflow.services import PlatformServices

_PROJECT_ID = "project-1"
_ENVIRONMENT = {
    "id": "env-1",
    "name": "Env",
    "browser": "Chromium",
    "baseUrl": "https://example.test",
    "timeout": 30,
}


def _capture_validation_input(services, monkeypatch):
    """Patch project resolution and the runner queue; return the captured
    enqueue inputs as a list."""
    captured: list[dict] = []

    def fake_enqueue(item_id, input, callbacks, kind="run", workspace_id=None):
        captured.append(
            {"id": item_id, "input": input, "kind": kind, "workspace_id": workspace_id}
        )

    monkeypatch.setattr(
        services,
        "project_for",
        lambda project_id: {"id": project_id, "workspace_id": "workspace-1"},
    )
    monkeypatch.setattr(services.managed_runner, "enqueue", fake_enqueue)
    return captured


def test_no_login_wall_is_never_flagged():
    assert _element_validation_login_error({"path": "/dashboard"}, False, None) is None
    assert (
        _element_validation_login_error({"path": "/dashboard"}, False, {"cookies": []})
        is None
    )
    # A missing path should not crash and cannot be a login-wall failure.
    assert _element_validation_login_error({}, False, None) is None


def test_login_wall_without_snapshot_requires_login_first():
    assert (
        _element_validation_login_error({"path": "/dashboard"}, True, None)
        == "ELEMENT_VALIDATION_LOGIN_REQUIRED"
    )
    # Empty/absent snapshot is treated the same as None.
    assert (
        _element_validation_login_error({"path": "/dashboard"}, True, {})
        == "ELEMENT_VALIDATION_LOGIN_REQUIRED"
    )


def test_login_wall_with_injected_snapshot_means_stale_session():
    assert (
        _element_validation_login_error({"path": "/dashboard"}, True, {"cookies": []})
        == "ELEMENT_VALIDATION_LOGIN_INVALID"
    )


def test_element_on_the_login_page_is_excluded():
    for path in ("/login", "/log-in", "/signin", "/sign-in", "/auth/login", "/account", "/Log-In"):
        assert _element_validation_login_error({"path": path}, True, None) is None, path
        assert (
            _element_validation_login_error({"path": path}, True, {"cookies": []})
            is None
        ), path


def test_enqueue_validation_passes_snapshot_into_runner_input(tmp_path, monkeypatch):
    """The recorder's login snapshot must reach the runner as storage_state."""
    services = PlatformServices(str(tmp_path))
    captured = _capture_validation_input(services, monkeypatch)
    storage_state = {"cookies": [{"name": "session", "value": "abc"}], "origins": []}
    services.enqueue_managed_validation(
        {
            "id": "validation-1",
            "projectId": _PROJECT_ID,
            "environmentId": "env-1",
            "element": {"id": "element-1", "path": "/dashboard"},
        },
        _ENVIRONMENT,
        storage_state,
    )
    assert len(captured) == 1
    assert captured[0]["kind"] == "validation"
    assert captured[0]["input"]["storage_state"] is storage_state
    assert captured[0]["input"]["environment"]["baseUrl"] == "https://example.test"
    assert captured[0]["workspace_id"] == "workspace-1"


def test_enqueue_validation_without_snapshot_omits_storage_state(tmp_path, monkeypatch):
    services = PlatformServices(str(tmp_path))
    captured = _capture_validation_input(services, monkeypatch)
    services.enqueue_managed_validation(
        {
            "id": "validation-1",
            "projectId": _PROJECT_ID,
            "environmentId": "env-1",
            "element": {"id": "element-1", "path": "/dashboard"},
        },
        _ENVIRONMENT,
    )
    assert len(captured) == 1
    assert captured[0]["input"]["storage_state"] is None


def test_validation_lookup_is_owner_scoped(tmp_path):
    """create_element_validation resolves the snapshot via the requesting user.

    The store is keyed by (owner, project, environment); a different owner's
    snapshot for the same project/environment must not be returned.
    """
    services = PlatformServices(str(tmp_path))
    other_state = {"cookies": [{"name": "session", "value": "other"}], "origins": []}
    services.recording_session_state.remember(
        {"ownerId": "owner-2", "projectId": _PROJECT_ID, "environmentId": "env-1"},
        other_state,
    )
    # owner-1 has no snapshot: the lookup create_element_validation performs
    # must come back empty, so owner-2's state cannot leak into validation.
    assert (
        services.recording_session_state.state_for("owner-1", _PROJECT_ID, "env-1")
        is None
    )
