from autoflow.runner import interpolate


def test_interpolate_resolves_scopes_and_fallbacks():
    input = {
        "environment": {"baseUrl": "https://example.test/app"},
        "variables": {
            "env.apiUrl": "https://api.example.test",
            "project.projectName": "AutoFlow",
            "flow.flowName": "Login",
            "plain": "plain-value",
        },
        "data": {"row": "row-1"},
        "secrets": {"token": "secret-value"},
    }
    outputs = {"flowName": "Login"}
    value = (
        "{{env.baseUrl}}|{{ env.apiUrl }}|{{project.projectName}}|"
        "{{ data.row }}|{{secret.token}}|{{ flow.flowName }}|{{plain}}|{{missing}}"
    )
    result = interpolate(value, input, outputs)
    assert result == (
        "https://example.test/app|https://api.example.test|AutoFlow|"
        "row-1|secret-value|Login|plain-value|"
    )


def test_interpolate_run_timestamp():
    value = interpolate("{{run.timestamp}}", {}, {})
    assert value.endswith("Z")
    assert "T" in value
