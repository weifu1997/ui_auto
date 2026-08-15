from autoflow.revision_snapshot import canonical_checksum


def flow(step_value: str = "/login"):
    return {
        "id": "flow-1",
        "name": "Flow name",
        "description": "description",
        "tags": ["regression"],
        "steps": [
            {
                "id": "step-1",
                "title": "Open",
                "action": "打开页面",
                "value": step_value,
                "timeout": 30,
                "failurePolicy": "立即失败",
                "status": "success",
            }
        ],
        "variables": {"project.username": "user"},
        "lastStatus": "success",
        "updatedAt": "刚刚",
    }


def environment(base_url: str = "https://example.test"):
    return {
        "id": "env-1",
        "name": "Env name",
        "description": "description",
        "baseUrl": base_url,
        "browser": "Chromium",
        "auth": "无认证",
        "timeout": 30,
        "testIdAttribute": "data-testid",
        "keepBrowserOpenOnFailure": False,
        "color": "teal",
        "updatedAt": "刚刚",
    }


def element(value: str = "login-button"):
    return {
        "id": "element-1",
        "name": "登录",
        "description": "description",
        "path": "/login",
        "method": "testid",
        "value": value,
        "environment": "env-1",
        "requiresLogin": False,
        "validation": "unverified",
        "updatedAt": "刚刚",
    }


def test_display_and_transient_fields_do_not_change_checksum():
    base = canonical_checksum(flow(), environment(), [element()], None, ["project.password"])
    changed = canonical_checksum(
        {
            **flow(),
            "name": "Renamed",
            "description": "Changed",
            "tags": ["other"],
            "lastStatus": "failed",
            "updatedAt": "2030-01-02T00:00:00.000Z",
            "steps": [
                {
                    **flow()["steps"][0],
                    "title": "Renamed title",
                    "status": "failed",
                }
            ],
        },
        {
            **environment(),
            "name": "Renamed",
            "description": "Changed",
            "color": "blue",
            "updatedAt": "2030-01-02T00:00:00.000Z",
        },
        [
            {
                **element(),
                "validation": "valid",
                "description": "Changed",
                "requiresLogin": True,
                "updatedAt": "2030-01-02T00:00:00.000Z",
            }
        ],
        None,
        ["project.password"],
    )
    assert base == changed


def test_element_array_order_does_not_change_checksum():
    first = canonical_checksum(
        flow(),
        environment(),
        [element("a"), element("b")],
    )
    second = canonical_checksum(
        flow(),
        environment(),
        [element("b"), element("a")],
    )
    assert first == second


def test_execution_field_changes_create_different_checksum():
    original = canonical_checksum(flow(), environment(), [element()])

    locator_changed = canonical_checksum(
        flow(),
        environment(),
        [element("other-button")],
    )
    action_changed = canonical_checksum(
        {
            **flow(),
            "steps": [{**flow()["steps"][0], "action": "点击"}],
        },
        environment(),
        [element()],
    )
    variable_changed = canonical_checksum(
        {
            **flow(),
            "variables": {"project.username": "other-user"},
        },
        environment(),
        [element()],
    )
    environment_changed = canonical_checksum(
        flow(),
        environment("https://other.example.test"),
        [element()],
    )

    assert original not in {
        locator_changed,
        action_changed,
        variable_changed,
        environment_changed,
    }
