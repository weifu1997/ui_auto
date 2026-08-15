import hashlib
import hmac
import json
from datetime import datetime, timezone

import pytest

from autoflow.core import (
    cron_field_matches,
    cron_matches,
    failure_category,
    next_cron_time,
    normalize_dataset_rows,
    notification_host_allowed_list,
    notification_rejection_code,
    parse_csv,
    public_flow_output_names,
    public_ip_address,
    webhook_signature_matches,
)
from autoflow.http import PlatformError, error_response


def test_cron_field_matches_exact_ranges_wildcards():
    assert cron_field_matches("5", 5, 0, 59)
    assert not cron_field_matches("5", 6, 0, 59)
    assert cron_field_matches("*", 42, 0, 59)
    assert cron_field_matches("1-5", 3, 1, 5)
    assert not cron_field_matches("1-5", 6, 1, 5)


def test_cron_field_matches_steps_and_lists():
    assert cron_field_matches("*/15", 30, 0, 59)
    assert not cron_field_matches("*/15", 31, 0, 59)
    assert cron_field_matches("1,3,5", 3, 0, 59)
    assert not cron_field_matches("1,3,5", 4, 0, 59)
    assert cron_field_matches("1-10/3", 7, 1, 10)
    assert not cron_field_matches("1-10/3", 8, 1, 10)


def test_cron_field_matches_rejects_invalid_inputs():
    assert not cron_field_matches("*/0", 5, 0, 59)
    assert not cron_field_matches("*/x", 5, 0, 59)
    assert not cron_field_matches("61", 61, 0, 59)
    assert not cron_field_matches("5", -1, 0, 59)


def test_cron_matches_fixed_timezone():
    date = datetime(2026, 1, 15, 1, 0, tzinfo=timezone.utc)
    assert cron_matches("0 9 * * *", date, "Asia/Shanghai")
    assert not cron_matches("0 9 * * *", datetime(2026, 1, 15, 2, 0, tzinfo=timezone.utc), "Asia/Shanghai")


def test_cron_matches_weekdays_and_month_days():
    thursday = datetime(2026, 1, 15, 1, 0, tzinfo=timezone.utc)
    assert cron_matches("0 9 * * 4", thursday, "Asia/Shanghai")
    assert not cron_matches("0 9 * * 1", thursday, "Asia/Shanghai")
    assert cron_matches("0 9 15 * *", thursday, "Asia/Shanghai")
    assert not cron_matches("0 9 20 * *", thursday, "Asia/Shanghai")


def test_cron_matches_rejects_malformed_expressions_and_timezones():
    assert not cron_matches("0 9", datetime.now(timezone.utc), "Asia/Shanghai")
    with pytest.raises(PlatformError):
        cron_matches("0 9 * * *", datetime.now(timezone.utc), "Not/AZone")


def test_next_cron_time():
    from_time = datetime(2026, 1, 15, 0, 30, tzinfo=timezone.utc)
    next_time = datetime.fromisoformat(
        next_cron_time("0 9 * * *", "Asia/Shanghai", from_time).replace("Z", "+00:00")
    )
    assert next_time > from_time
    assert cron_matches("0 9 * * *", next_time, "Asia/Shanghai")


def test_next_cron_time_rejects_impossible_expression():
    with pytest.raises(PlatformError):
        next_cron_time(
            "0 9 30 2 *",
            "Asia/Shanghai",
            datetime(2026, 1, 1, tzinfo=timezone.utc),
        )


def test_parse_csv_simple_rows():
    assert parse_csv("a,b\n1,2") == [["a", "b"], ["1", "2"]]


def test_parse_csv_quoted_cells():
    assert parse_csv('name,note\n"Smith, John","said ""hi"""') == [
        ["name", "note"],
        ["Smith, John", 'said "hi"'],
    ]


def test_parse_csv_ignores_carriage_returns():
    assert parse_csv("a,b\r\n1,2\r\n") == [["a", "b"], ["1", "2"]]


def test_parse_csv_rejects_unterminated_quotes():
    with pytest.raises(PlatformError):
        parse_csv('"unclosed')


def test_normalize_dataset_rows():
    result = normalize_dataset_rows([["name", "age"], ["alice", "30"], ["bob", "25"]])
    assert result["columns"] == ["name", "age"]
    assert result["rows"] == [{"name": "alice", "age": "30"}, {"name": "bob", "age": "25"}]


def test_normalize_dataset_rows_strips_bom_and_trims_headers():
    result = normalize_dataset_rows([["\ufeffname ", "age"], ["alice", "30"]])
    assert result["columns"] == ["name", "age"]


def test_normalize_dataset_rows_matches_js_string_conversions():
    result = normalize_dataset_rows([[False, 0], [False, 0]])
    assert result["columns"] == ["false", "0"]
    assert result["rows"] == [{"false": "false", "0": "0"}]


def test_normalize_dataset_rows_rejects_duplicate_headers():
    with pytest.raises(PlatformError):
        normalize_dataset_rows([["Name", "name"], ["a", "b"]])


def test_normalize_dataset_rows_rejects_empty_headers_and_missing_rows():
    with pytest.raises(PlatformError):
        normalize_dataset_rows([["", "b"], ["a", "b"]])
    with pytest.raises(PlatformError):
        normalize_dataset_rows([["a", "b"]])


def test_normalize_dataset_rows_skips_empty_rows_and_enforces_limit():
    many = [["a", "b"], *[[f"r{i}", "x"] for i in range(10002)]]
    with pytest.raises(PlatformError):
        normalize_dataset_rows(many)
    with_empty = normalize_dataset_rows([["a", "b"], ["", ""], ["1", "2"]])
    assert with_empty["rows"] == [{"a": "1", "b": "2"}]


def test_failure_category_message_classification():
    assert failure_category("TIMEOUT waiting for selector") == "timeout"
    assert failure_category("ELEMENT_NOT_FOUND for #submit") == "locator"
    assert failure_category("expect(received).toBe() ASSERTION_FAILED") == "assertion"
    assert failure_category("net::ERR_CONNECTION_REFUSED") == "network"
    assert failure_category("BROWSER_LAUNCH_FAILED") == "browser"
    assert failure_category("RUN_CANCELED by user") == "canceled"


def test_failure_category_fallback():
    assert failure_category("something unexpected") == "other"
    assert failure_category(None) == "other"


def test_failure_category_code_classification():
    assert failure_category("some message", "ELEMENT_NOT_FOUND") == "locator"
    assert failure_category("some message", "TIMEOUT_EXPIRED") == "timeout"
    assert failure_category("some message", "ASSERT_FAILED") == "assertion"
    assert failure_category("some message", "NETWORK_ERROR") == "network"
    assert failure_category("some message", "ECONNREFUSED") == "network"
    assert failure_category("some message", "BROWSER_CRASH") == "browser"
    assert failure_category("some message", "RUN_CANCELED") == "canceled"


def test_failure_category_code_fallback_to_message():
    assert failure_category("Timeout waiting for selector", "UNKNOWN_CODE_42") == "timeout"
    assert failure_category("STRICT MODE violation", "OK") == "locator"
    assert failure_category("", "NOTIFICATION_REJECTED_19024") == "other"


def test_public_flow_output_names():
    run = {
        "snapshot": {
            "flow": {
                "steps": [
                    {"output": "orderId", "outputPublic": True},
                    {"output": "secret", "outputPublic": False},
                    {"storeAs": "cartTotal", "outputPublic": True},
                ]
            }
        }
    }
    names = public_flow_output_names(run)
    assert "orderId" in names
    assert "cartTotal" in names
    assert "secret" not in names


def test_public_flow_output_names_ignores_malformed_names():
    run = {
        "snapshot": {
            "flow": {
                "steps": [{"output": "bad name!", "outputPublic": True}]
            }
        }
    }
    assert public_flow_output_names(run) == set()


def test_public_ip_address():
    assert public_ip_address("8.8.8.8")
    assert not public_ip_address("10.0.0.1")
    assert not public_ip_address("192.168.1.1")
    assert not public_ip_address("172.16.0.1")
    assert not public_ip_address("127.0.0.1")
    assert public_ip_address("2001:4860:4860::8888")
    assert not public_ip_address("::1")
    assert not public_ip_address("fe80::1")


def test_notification_host_allowed():
    allowlist = ["hooks.corp.test", "*.notify.corp.test"]
    assert notification_host_allowed_list("hooks.corp.test", allowlist)
    assert notification_host_allowed_list("team.notify.corp.test", allowlist)
    assert not notification_host_allowed_list("notify.corp.test", allowlist)
    assert not notification_host_allowed_list("hooks.corp.test.attacker.test", allowlist)


def test_notification_rejection_code():
    assert notification_rejection_code(json.dumps({"code": 19001})) == 19001
    assert notification_rejection_code(json.dumps({"errcode": 310000})) == 310000
    assert notification_rejection_code(json.dumps({"code": 19001, "errcode": 310000})) == 19001


def test_notification_rejection_code_ignores_success_and_malformed():
    assert notification_rejection_code(json.dumps({"code": 0})) is None
    assert notification_rejection_code(json.dumps({"errcode": 0})) is None
    assert notification_rejection_code("not-json") is None
    assert notification_rejection_code(None) is None


def test_webhook_signature_matches():
    secret = "test-secret"
    body = json.dumps({"runId": "r1"}, separators=(",", ":")).encode()
    expected = "sha256=" + hmac.new(
        secret.encode(),
        f"1735689600.{body.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    assert webhook_signature_matches(secret, "1735689600", body, expected)
    assert not webhook_signature_matches(secret, "1735689600", b"tampered", expected)
    assert not webhook_signature_matches("wrong-secret", "1735689600", body, expected)


def test_error_response():
    assert error_response(PlatformError(404, "PROJECT_NOT_FOUND")) == {
        "status": 404,
        "code": "PROJECT_NOT_FOUND",
    }


def test_error_response_hides_unknown_errors():
    sql = RuntimeError('SQLITE_ERROR: near "/var/lib/data": syntax error')
    assert error_response(sql) == {"status": 500, "code": "INTERNAL_ERROR"}
    assert error_response({"weird": True}) == {"status": 500, "code": "INTERNAL_ERROR"}


def test_error_response_internal_code():
    assert error_response(RuntimeError("boom"), options={"internal_code": "PLATFORM_INTERNAL_ERROR"}) == {
        "status": 500,
        "code": "PLATFORM_INTERNAL_ERROR",
    }


def test_error_response_expose_message_only_when_enabled():
    assert error_response(RuntimeError("RUN_NOT_FOUND"), options={"expose_message": True}) == {
        "status": 404,
        "code": "RUN_NOT_FOUND",
    }
    assert error_response(RuntimeError("RUN_SECRETS_REQUIRED"), options={"expose_message": True}) == {
        "status": 409,
        "code": "RUN_SECRETS_REQUIRED",
    }
    assert error_response(RuntimeError("ENVIRONMENT_REQUIRED"), options={"expose_message": True}) == {
        "status": 400,
        "code": "ENVIRONMENT_REQUIRED",
    }
    assert error_response(RuntimeError("ENVIRONMENT_REQUIRED")) == {
        "status": 500,
        "code": "INTERNAL_ERROR",
    }
