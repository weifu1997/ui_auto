"""Recording Phase 1: session lifecycle, payload validation, target URL rules."""

import concurrent.futures
import json
import threading
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import pytest

from autoflow.http import PlatformError
from autoflow.recorder import (
    RecordingCoordinator,
    RecorderNormalizer,
    recording_target_url,
    sanitize_url,
    validate_recorder_event,
)

FIXTURES = Path(__file__).parent.parent / "fixtures" / "recorder"


class _StubFuture:
    def __init__(self, value):
        self._value = value

    def result(self, timeout=None):
        return self._value


class _ImmediateSubmit:
    """同步执行提交，模拟专用 Playwright 线程。"""

    def __call__(self, function, *args):
        return _StubFuture(function(*args))


class _StubContext:
    def __init__(self):
        self.init_scripts = []
        self.bindings = {}
        self.closed = False

    def add_init_script(self, script):
        self.init_scripts.append(script)

    def expose_binding(self, name, callback):
        self.bindings[name] = callback

    def close(self):
        self.closed = True


class _StubBrowser:
    def __init__(self):
        self.closed = False
        self.handlers = {}

    def on(self, event, handler):
        self.handlers[event] = handler

    def close(self):
        self.closed = True


class _StubPlaywright:
    def __init__(self):
        self.stopped = False

    def stop(self):
        self.stopped = True


class _StubPage:
    def __init__(self, context):
        self.context = context
        self.goto_targets = []
        self.handlers = {}
        self.url = ""

    @property
    def main_frame(self):
        return self

    def on(self, event, handler):
        self.handlers[event] = handler

    def goto(self, target, **_kwargs):
        self.goto_targets.append(target)
        self.url = target
        handler = self.handlers.get("framenavigated")
        if handler:
            handler(self)


def _stub_launch(state):
    context = _StubContext()
    return {
        "playwright": _StubPlaywright(),
        "browser": _StubBrowser(),
        "context": context,
        "page": _StubPage(context),
        "state": state,
    }


ENVIRONMENT = {
    "id": "env-1",
    "name": "测试环境",
    "browser": "Chromium",
    "baseUrl": "https://app.test",
    "testIdAttribute": "data-testid",
}


def test_sanitize_url_strips_userinfo_query_and_fragment():
    assert sanitize_url("https://user:pw@app.test/path?token=1#x") == (
        "https://app.test/path"
    )
    assert sanitize_url("https://app.test/path?q=1#x") == "https://app.test/path"


    assert recording_target_url("https://app.test", "/login?from=nav") == (
        "https://app.test/login?from=nav"
    )
    assert (
        recording_target_url("https://app.test/base/", "https://app.test/base/one")
        == "https://app.test/base/one"
    )
    for bad in (
        "https://user:pw@app.test/login",
        "https://evil.test/login",
        "http://app.test/login",
        "javascript:alert(1)",
        "https://app.test:8443/login",
        "https://app.test:not-a-port/login",
    ):
        with pytest.raises(PlatformError) as error:
            recording_target_url("https://app.test", bad)
        assert error.value.code == "RECORDING_START_URL_INVALID"
    with pytest.raises(PlatformError) as error:
        recording_target_url("ftp://app.test", "/login")
    assert error.value.code == "RECORDING_ENVIRONMENT_INVALID"
    with pytest.raises(PlatformError) as error:
        recording_target_url("https://app.test:not-a-port", "/login")
    assert error.value.code == "RECORDING_ENVIRONMENT_INVALID"


def test_validate_recorder_event_normalizes_and_drops():
    assert validate_recorder_event(None) is None
    assert validate_recorder_event("click") is None
    assert validate_recorder_event({"kind": "navigate"}) is None

    event = validate_recorder_event({
        "kind": "click",
        "frame": "child",
        "url": "https://app.test/p?token=1#x",
        "element": {"tag": "button", "testid": "go", "text": "确定" * 50},
        "at": 123,
    })
    assert event["frame"] == "child"
    assert event["url"] == "https://app.test/p"
    assert event["element"]["text"] == "确定" * 50
    assert event["value"] is None

    sensitive = validate_recorder_event({
        "kind": "input",
        "element": {"tag": "input", "type": "password", "name": "pwd"},
        "sensitive": False,
        "value": "leak-attempt",
    })
    assert sensitive["sensitive"] is True
    assert sensitive["value"] is None

    autocomplete_sensitive = validate_recorder_event({
        "kind": "input",
        "element": {
            "tag": "INPUT",
            "type": "PASSWORD",
            "autocomplete": "current-password",
        },
        "value": "sensitive-value-must-not-leak",
    })
    assert autocomplete_sensitive["element"]["autocomplete"] == "current-password"
    assert autocomplete_sensitive["sensitive"] is True
    assert autocomplete_sensitive["value"] is None
    assert "sensitive-value-must-not-leak" not in json.dumps(autocomplete_sensitive)

    sensitive_change = validate_recorder_event({
        "kind": "change",
        "element": {"tag": "select", "autocomplete": "current-password"},
        "sensitive": True,
        "selectedValue": "sensitive-selection-must-not-leak",
    })
    assert sensitive_change["selectedValue"] is None
    assert "sensitive-selection-must-not-leak" not in json.dumps(sensitive_change)

    change = validate_recorder_event({
        "kind": "change",
        "element": {"tag": "select", "testid": "role"},
        "selectedValue": "tester",
        "checked": True,
    })
    assert change["selectedValue"] == "tester"
    assert change["checked"] is True

    keydown = validate_recorder_event({"kind": "keydown", "key": "Enter"})
    assert keydown["key"] == "Enter"

    unsupported = validate_recorder_event({
        "kind": "unsupported",
        "feature": "contenteditable",
        "at": "not-a-timestamp",
    })
    assert unsupported["feature"] == "contenteditable"
    assert unsupported["at"] == 0

    normalizer = RecorderNormalizer("https://app.test/login")
    normalizer.append(unsupported)
    normalizer.append({"kind": "dragstart", "at": 1})
    warnings = normalizer.result()["warnings"]
    assert any("contenteditable" in warning for warning in warnings)
    assert any("drag" in warning for warning in warnings)


def test_initial_navigation_same_path_does_not_duplicate_start_step():
    normalizer = RecorderNormalizer("https://app.test/")
    normalizer.append({
        "kind": "navigate",
        "url": "https://app.test/?utm_source=recording#home",
        "at": 100,
    })

    result = normalizer.result()
    assert [(step["action"], step.get("value")) for step in result["steps"]] == [
        ("打开页面", "/")
    ]

    normalizer.note_navigation("https://app.test/home", at=200)
    assert normalizer.result()["steps"][-1]["value"] == "/home"


def test_coordinator_lifecycle_pause_stop_cancel_and_expiry():
    launched = []

    def launch(headless, storage_state=None):
        session = _stub_launch({"headless": headless, "storage": storage_state})
        launched.append(session)
        return session

    clock = {"now": 1_000_000}
    coordinator = RecordingCoordinator(
        submit=_ImmediateSubmit(),
        launch=launch,
        idle_ms=1000,
        max_ms=100_000,
        now_ms=lambda: clock["now"],
    )
    created = coordinator.create_session(
        "project-1", "flow-1", ENVIRONMENT, "/login?next=/home", headless=True
    )
    assert created["status"] == "recording"
    assert created["currentUrl"] == "https://app.test/login"
    browser = launched[0]
    assert browser["page"].goto_targets == ["https://app.test/login?next=/home"]
    assert browser["context"].init_scripts
    emit = lambda payload: browser["context"].bindings["__autoflowRecorderEvent"](None, payload)

    with pytest.raises(PlatformError) as error:
        coordinator.create_session("project-1", "flow-2", ENVIRONMENT, "/login")
    assert error.value.code == "RECORDING_SESSION_ACTIVE"

    emit({"kind": "input", "url": "https://app.test/login",
          "element": {"tag": "input", "type": "text", "testid": "login-username",
                      "label": "用户名"}, "value": "tester", "at": 10})
    emit({"kind": "click", "url": "https://app.test/login",
          "element": {"tag": "button", "testid": "login-submit", "text": "登录",
                      "role": "button", "accessibleName": "登录"}, "at": 20})
    browser["page"].url = "https://app.test/home?ticket=1"
    browser["page"].handlers["framenavigated"](browser["page"])
    assert coordinator.events_after(created["id"], 0)["lastSeq"] >= 3

    emit({"kind": "input", "url": "https://app.test/home",
          "element": {"tag": "input", "testid": "search"}, "value": "before-pause", "at": 25})
    coordinator.pause(created["id"])
    seq_before = coordinator.events_after(created["id"], 0)["lastSeq"]
    emit({"kind": "input", "url": "https://app.test/home",
          "element": {"tag": "input", "testid": "search"}, "value": "ignored", "at": 30})
    after_pause = coordinator.events_after(created["id"], 0)
    assert after_pause["lastSeq"] == seq_before
    assert not [
        event for event in after_pause["events"] if event.get("value") == "ignored"
    ]
    coordinator.resume(created["id"])
    emit({"kind": "input", "url": "https://app.test/home",
          "element": {"tag": "input", "testid": "search"}, "value": "after-resume", "at": 35})
    browser["page"].handlers["popup"]()
    browser["page"].handlers["filechooser"]()
    browser["page"].handlers["download"]()
    browser["page"].url = "https://outside.test/account?token=should-not-record"
    browser["page"].handlers["framenavigated"](browser["page"])
    emit({
        "kind": "click",
        "url": "https://outside.test/account",
        "element": {"tag": "button", "testid": "outside"},
        "at": 40,
    })

    stopped = coordinator.stop(created["id"])
    assert stopped["status"] == "stopped"
    assert coordinator.stop(created["id"])["status"] == "stopped"
    result = coordinator.session_result(created["id"])
    actions = [(step["action"], step.get("value")) for step in result["result"]["steps"]]
    assert actions == [
        ("打开页面", "/login"),
        ("填写", "tester"),
        ("点击", None),
        ("打开页面", "/home"),
        ("填写", "before-pause"),
        ("填写", "after-resume"),
    ]
    assert any("popup" in warning for warning in result["result"]["warnings"])
    assert any("filechooser" in warning for warning in result["result"]["warnings"])
    assert any("download" in warning for warning in result["result"]["warnings"])
    assert any("外部域" in warning for warning in result["result"]["warnings"])
    assert all("outside.test" not in json.dumps(step) for step in result["result"]["steps"])
    assert browser["context"].closed and browser["browser"].closed
    assert browser["playwright"].stopped
    assert result["session"]["status"] == "stopped"

    canceled = coordinator.create_session("project-1", "flow-3", ENVIRONMENT, "/login")
    assert coordinator.cancel(canceled["id"])["status"] == "canceled"

    expiring = coordinator.create_session("project-1", "flow-4", ENVIRONMENT, "/login")
    clock["now"] += 2000
    assert coordinator.sweep_expired() == [expiring["id"]]
    assert coordinator.session_response(coordinator._require_session(expiring["id"]))["status"] == "expired"
    coordinator.close_all()


def test_cancel_active_ends_matching_session_for_owner_and_environment():
    coordinator = RecordingCoordinator(
        submit=_ImmediateSubmit(),
        launch=lambda headless, storage_state=None: _stub_launch(
            {"headless": headless, "storage": storage_state}
        ),
    )
    first = coordinator.create_session("project-1", "flow-1", ENVIRONMENT, "/login")
    second = coordinator.create_session(
        "project-1", "flow-2", {**ENVIRONMENT, "id": "env-2"}, "/login"
    )
    try:
        # Other owners must not be touched.
        assert coordinator.cancel_active("project-1", "env-1", "other-owner") is None
        assert coordinator.cancel_active("project-1", "env-2", "other-owner") is None

        canceled = coordinator.cancel_active("project-1", "env-1", "")
        assert canceled is not None
        assert canceled["id"] == first["id"]
        assert canceled["status"] == "canceled"

        # A second call has nothing left to cancel.
        assert coordinator.cancel_active("project-1", "env-1", "") is None

        # The non-matching session is still active.
        assert (
            coordinator.session_response(coordinator._require_session(second["id"]))["status"]
            == "recording"
        )
    finally:
        coordinator.cancel(second["id"])


def test_create_session_failure_closes_launched_browser():
    launched = []

    class _RaisingPage(_StubPage):
        def goto(self, target, **_kwargs):
            self.goto_targets.append(target)
            raise RuntimeError("boom")

    def launch(headless, storage_state=None):
        context = _StubContext()
        session = {
            "playwright": _StubPlaywright(),
            "browser": _StubBrowser(),
            "context": context,
            "page": _RaisingPage(context),
        }
        launched.append(session)
        return session

    failures = []
    coordinator = RecordingCoordinator(
        submit=_ImmediateSubmit(), launch=launch, on_failed=failures.append
    )
    with pytest.raises(PlatformError) as error:
        coordinator.create_session(
            "project-fail", "flow-1", ENVIRONMENT, "/login", headless=True
        )
    assert error.value.status == 409
    assert error.value.code == "RECORDING_NAVIGATION_FAILED"
    assert launched
    browser = launched[0]
    assert browser["context"].closed is True
    assert browser["browser"].closed is True
    assert browser["playwright"].stopped is True
    assert len(failures) == 1
    failed = coordinator._require_session(failures[0]["id"])
    assert failed["status"] == "failed"
    assert failed["errorCode"] == "RECORDING_NAVIGATION_FAILED"


def test_initial_navigation_failure_falls_back_to_blank_page_and_stays_recording():
    launched = []

    class _FallbackPage(_StubPage):
        def goto(self, target, **_kwargs):
            self.goto_targets.append(target)
            if target != "about:blank":
                raise RuntimeError("target unreachable")
            self.url = target
            handler = self.handlers.get("framenavigated")
            if handler:
                handler(self)

    def launch(headless, storage_state=None):
        context = _StubContext()
        session = {
            "playwright": _StubPlaywright(),
            "browser": _StubBrowser(),
            "context": context,
            "page": _FallbackPage(context),
        }
        launched.append(session)
        return session

    coordinator = RecordingCoordinator(submit=_ImmediateSubmit(), launch=launch)
    created = coordinator.create_session(
        "project-1", "flow-1", ENVIRONMENT, "/login", headless=True
    )
    assert created["status"] == "recording"
    assert launched[0]["page"].goto_targets == [
        "https://app.test/login",
        "about:blank",
    ]
    stopped = coordinator.stop(created["id"])
    assert stopped["status"] == "stopped"
    result = coordinator.session_result(created["id"])["result"]
    assert any("初始页面导航失败" in warning for warning in result["warnings"])


def test_recording_snapshot_is_detached_from_provider_and_fresh_login_skips_it():
    launched = []
    login_state = {
        "origins": [
            {"origin": "https://app.test", "localStorage": [{"name": "seed", "value": "1"}]}
        ]
    }

    def launch(headless, storage_state=None):
        assert storage_state is not login_state
        storage_state["origins"][0]["localStorage"].append(
            {"name": "recorder-only", "value": "true"}
        )
        session = _stub_launch({"headless": headless, "storage": storage_state})
        launched.append(session)
        return session

    snapshot_calls = []
    coordinator = RecordingCoordinator(submit=_ImmediateSubmit(), launch=launch)
    created = coordinator.create_session(
        "project-1",
        "flow-1",
        ENVIRONMENT,
        "/login",
        login_state_provider=lambda project_id, environment_id: (
            snapshot_calls.append((project_id, environment_id)) or login_state
        ),
    )
    assert snapshot_calls == [("project-1", "env-1")]
    assert login_state["origins"][0]["localStorage"] == [{"name": "seed", "value": "1"}]
    assert launched[0]["state"]["storage"]["origins"][0]["localStorage"][-1]["name"] == "recorder-only"
    coordinator.cancel(created["id"])

    fresh_calls = []
    fresh = RecordingCoordinator(
        submit=_ImmediateSubmit(),
        launch=lambda headless, storage_state=None: _stub_launch(
            {"headless": headless, "storage": storage_state}
        ),
    )
    fresh_created = fresh.create_session(
        "project-1",
        "flow-2",
        ENVIRONMENT,
        "/login",
        fresh_login=True,
        login_state_provider=lambda *_args: fresh_calls.append("called") or login_state,
    )
    assert fresh_calls == []
    fresh.cancel(fresh_created["id"])


def test_terminal_cleanup_handles_completed_non_pumping_session():
    launched = []

    def launch(headless, storage_state=None):
        session = _stub_launch({"headless": headless, "storage": storage_state})
        launched.append(session)
        return session

    coordinator = RecordingCoordinator(submit=_ImmediateSubmit(), launch=launch)
    created = coordinator.create_session("project-1", "flow-1", ENVIRONMENT, "/login")
    assert coordinator.cancel(created["id"])["status"] == "canceled"
    browser = launched[0]
    assert browser["context"].closed is True
    assert browser["browser"].closed is True
    assert browser["playwright"].stopped is True


def test_page_close_marks_session_failed_releases_resources_and_audits_once():
    launched = []
    failures = []

    def launch(headless, storage_state=None):
        session = _stub_launch({"headless": headless, "storage": storage_state})
        launched.append(session)
        return session

    coordinator = RecordingCoordinator(
        submit=_ImmediateSubmit(), launch=launch, on_failed=failures.append
    )
    created = coordinator.create_session("project-1", "flow-1", ENVIRONMENT, "/login")
    browser = launched[0]
    browser["page"].handlers["close"]()
    browser["page"].handlers["close"]()

    response = coordinator.session_response(coordinator._require_session(created["id"]))
    assert response["status"] == "failed"
    assert response["errorCode"] == "RECORDING_PAGE_CLOSED"
    assert browser["context"].closed is True
    assert browser["browser"].closed is True
    assert browser["playwright"].stopped is True
    assert len(failures) == 1
    assert coordinator.stop(created["id"])["status"] == "failed"


def test_browser_disconnection_marks_session_failed_and_uses_stable_code():
    launched = []

    def launch(headless, storage_state=None):
        session = _stub_launch({"headless": headless, "storage": storage_state})
        launched.append(session)
        return session

    coordinator = RecordingCoordinator(submit=_ImmediateSubmit(), launch=launch)
    created = coordinator.create_session("project-1", "flow-1", ENVIRONMENT, "/login")
    launched[0]["browser"].handlers["disconnected"]()

    response = coordinator.session_response(coordinator._require_session(created["id"]))
    assert response["status"] == "failed"
    assert response["errorCode"] == "RECORDING_BROWSER_DISCONNECTED"


def test_browser_launch_failure_is_a_stable_4xx_error():
    def launch(_headless, _storage_state=None):
        raise RuntimeError("browser executable unavailable")

    coordinator = RecordingCoordinator(submit=_ImmediateSubmit(), launch=launch)
    with pytest.raises(PlatformError) as error:
        coordinator.create_session("project-1", "flow-1", ENVIRONMENT, "/login")
    assert error.value.status == 409
    assert error.value.code == "RECORDING_BROWSER_START_FAILED"


def test_browser_setup_failure_is_reported_as_start_failure_and_cleaned_up():
    launched = []

    class _BrokenContext(_StubContext):
        def add_init_script(self, _script):
            raise RuntimeError("binding setup failed")

    def launch(headless, storage_state=None):
        context = _BrokenContext()
        session = {
            "playwright": _StubPlaywright(),
            "browser": _StubBrowser(),
            "context": context,
            "page": _StubPage(context),
        }
        launched.append(session)
        return session

    coordinator = RecordingCoordinator(submit=_ImmediateSubmit(), launch=launch)
    with pytest.raises(PlatformError) as error:
        coordinator.create_session("project-1", "flow-1", ENVIRONMENT, "/login")
    assert error.value.code == "RECORDING_BROWSER_START_FAILED"
    assert launched[0]["context"].closed
    assert launched[0]["browser"].closed
    assert launched[0]["playwright"].stopped


@pytest.fixture(scope="module")
def fixture_server():
    handler = partial(SimpleHTTPRequestHandler, directory=str(FIXTURES))
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_coordinator_real_browser_pumps_idle_binding_events(fixture_server):
    submitter = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    coordinator = None
    created = None
    try:
        coordinator = RecordingCoordinator(submit=submitter.submit)
        environment = {**ENVIRONMENT, "baseUrl": fixture_server}
        created = coordinator.create_session(
            "project-1",
            "flow-1",
            environment,
            "/page1.html?delayed-recorder-events=1",
            headless=True,
        )
        assert created["status"] == "recording"
        deadline = threading.Event()
        for _attempt in range(50):
            preview = coordinator.events_after(created["id"], 0)
            if preview["lastSeq"] >= 3:
                break
            deadline.wait(0.1)
        else:
            pytest.fail("idle browser interaction did not reach the recorder binding")
        assert coordinator.session_response(
            coordinator._require_session(created["id"])
        )["recordedStepCount"] >= 3
        stopped = coordinator.stop(created["id"])
        assert stopped["status"] == "stopped"
        result = coordinator.session_result(created["id"])
        actions = [(step["action"], step.get("value")) for step in result["result"]["steps"]]
        assert actions == [
            ("打开页面", "/page1.html"),
            ("填写", "idle-user"),
            ("点击", None),
        ]
        assert coordinator._require_session(created["id"])["browserSession"] is None
    finally:
        if coordinator is not None and created is not None:
            coordinator.cancel(created["id"])
        submitter.shutdown(wait=True)


def test_create_session_fails_fast_when_global_recording_slots_are_full():
    launched = []

    def launch(headless, storage_state):
        session = _stub_launch(storage_state)
        launched.append(session)
        return session

    coordinator = RecordingCoordinator(
        submit=_ImmediateSubmit(),
        launch=launch,
        idle_ms=1000,
        max_ms=100_000,
        now_ms=lambda: 1_000_000,
        max_concurrent=1,
    )
    first = coordinator.create_session(
        "project-1", "flow-1", ENVIRONMENT, "/login", headless=True
    )
    assert first["status"] == "recording"
    other_env = {**ENVIRONMENT, "id": "env-2"}
    with pytest.raises(PlatformError) as error:
        coordinator.create_session(
            "project-1", "flow-2", other_env, "/login", owner_id="other", headless=True
        )
    assert error.value.code == "RECORDING_BUSY"


def test_create_session_init_script_uses_environment_testid_attribute():
    launched = []

    def launch(headless, storage_state):
        session = _stub_launch(storage_state)
        launched.append(session)
        return session

    coordinator = RecordingCoordinator(
        submit=_ImmediateSubmit(),
        launch=launch,
        idle_ms=1000,
        max_ms=100_000,
        now_ms=lambda: 1_000_000,
    )
    env = {**ENVIRONMENT, "testIdAttribute": "data-cy"}
    coordinator.create_session("project-1", "flow-1", env, "/login", headless=True)
    script = launched[0]["context"].init_scripts[0]
    assert 'getAttribute("data-cy")' in script
    assert 'getAttribute("data-testid")' not in script
