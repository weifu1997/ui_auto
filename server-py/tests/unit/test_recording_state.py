from fastapi.testclient import TestClient

from autoflow.main import create_app
from autoflow.recorder import RecordingCoordinator
from autoflow.recording_state import RecordingSessionStateStore
from autoflow.services import PlatformServices


class _ImmediateFuture:
    def __init__(self, value):
        self.value = value

    def result(self, timeout=None):
        return self.value


class _ImmediateSubmit:
    def __call__(self, function, *args):
        return _ImmediateFuture(function(*args))


class _Context:
    def __init__(self, storage_state):
        self.storage = storage_state

    def add_init_script(self, _script):
        pass

    def expose_binding(self, _name, _callback):
        pass

    def on(self, _event, _callback):
        pass

    def storage_state(self):
        return self.storage

    def close(self):
        pass


class _Browser:
    def on(self, _event, _callback):
        pass

    def close(self):
        pass


class _Playwright:
    def stop(self):
        pass


class _Page:
    url = ""

    @property
    def main_frame(self):
        return self

    def on(self, _event, _callback):
        pass

    def goto(self, target, **_kwargs):
        self.url = target


ENVIRONMENT = {
    "id": "environment-1",
    "name": "Test environment",
    "browser": "Chromium",
    "baseUrl": "https://app.test",
}


def test_recording_state_is_scoped_and_detached():
    store = RecordingSessionStateStore()
    session = {
        "ownerId": "owner-1",
        "projectId": "project-1",
        "environmentId": "environment-1",
    }
    source = {"cookies": [{"name": "session", "value": "secret"}]}

    store.remember(session, source)
    source["cookies"][0]["value"] = "changed"

    assert store.state_for("owner-1", "project-1", "environment-1") == {
        "cookies": [{"name": "session", "value": "secret"}]
    }
    assert store.state_for("other-owner", "project-1", "environment-1") is None


def test_recording_coordinator_captures_stopped_browser_state():
    storage = {"cookies": [{"name": "session", "value": "secret"}]}
    store = RecordingSessionStateStore()

    def launch(_headless, _storage_state):
        context = _Context(storage)
        return {
            "playwright": _Playwright(),
            "browser": _Browser(),
            "context": context,
            "page": _Page(),
        }

    coordinator = RecordingCoordinator(
        submit=_ImmediateSubmit(),
        launch=launch,
        on_storage_state=store.remember,
    )
    session = coordinator.create_session(
        "project-1",
        "flow-1",
        ENVIRONMENT,
        "/login",
        owner_id="owner-1",
    )

    coordinator.stop(session["id"])

    assert store.state_for("owner-1", "project-1", "environment-1") == storage


def test_legacy_worker_routes_are_not_registered_or_served(tmp_path):
    services = PlatformServices(str(tmp_path))
    app = create_app(services)
    paths = {getattr(route, "path", "") for route in app.routes}
    assert "/api/projects/{project_id}/runs" not in paths
    assert not hasattr(app.state, "worker")

    with TestClient(app) as client:
        response = client.get("/api/projects/project-1/runs")
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}
