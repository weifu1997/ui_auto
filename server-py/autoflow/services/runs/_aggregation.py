"""Service-level and assertion aggregation across runs."""
from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from typing import Any
from ...core import days_ago_iso, parse_json
from ...resources import as_record

class _AggregationMixin:
    """Service-level + assertion aggregation."""

    def metrics(self) -> dict[str, Any]:
        """OBS-02 service-level metrics (DB-backed, JSON)."""
        run_counts: dict[str, int] = {}
        for row in self.database.execute(
            "SELECT status, COUNT(*) FROM platform_runs GROUP BY status"
        ).fetchall():
            run_counts[str(row[0])] = int(row[1])

        delivery_counts: dict[str, int] = {}
        for row in self.database.execute(
            "SELECT status, COUNT(*) FROM deliveries GROUP BY status"
        ).fetchall():
            delivery_counts[str(row[0])] = int(row[1])

        disk: dict[str, int] | None = None
        try:
            usage = shutil.disk_usage(str(self.data_directory))
            disk = {"total": usage.total, "used": usage.used, "free": usage.free}
        except Exception:
            pass

        return {
            "runs": run_counts,
            "deliveries": delivery_counts,
            "disk": disk,
            "artifactBytes": self._artifact_bytes(),
        }

    def _artifact_bytes(self) -> int:
        total = 0
        try:
            for path in self.managed_runner.artifact_directory.rglob("*"):
                if path.is_file():
                    total += path.stat().st_size
        except Exception:
            pass
        return total

    def assertion_stats(
        self, project_id: str, window_days: int | None = None
    ) -> dict[str, Any]:
        """项目级断言聚合（仅统计正式终态 run，非分页口径）。

        W1-6 口径修正：只纳入 `status IN ('success','failed')` 且非取消的
        run——编辑器试跑此前直接写库并混入分子分母，导致通过率被试跑污染；
        canceled 的半截结果同样不具统计意义。SQLite 对 JSON 列聚合不友好，
        应用层扫描 result 累加。window_days 为 None 或 <=0 时为全量窗口。
        返回含 windowDays。
        """
        params: list[Any] = [project_id]
        window_sql = ""
        if window_days is not None and window_days > 0:
            window_sql = "AND created_at >= ?"
            params.append(days_ago_iso(window_days))
        rows = self.database.execute(
            f"""
            SELECT result FROM platform_runs
            WHERE project_id = ?
              AND status IN ('success', 'failed')
              {window_sql}
            """,
            tuple(params),
        ).fetchall()
        runs = [{"result": parse_json(row[0], None)} for row in rows]
        stats = self.assertion_stats_for_runs(runs)
        stats["windowDays"] = window_days
        return stats

    def assertion_stats_for_runs(self, runs: list[dict[str, Any]]) -> dict[str, int]:
        """跨 run 应用层聚合断言计数（口径写死：分子=含断言 run 中 passed 总数，
        分母=含断言 run 的断言总数；无断言 run 不进分子分母）。"""
        runs_with_assertions = 0
        total = 0
        passed = 0
        for run in runs:
            result = as_record(run.get("result"))
            assertions = result.get("assertions") if isinstance(result, dict) else None
            if not isinstance(assertions, list):
                continue
            total_this = 0
            passed_this = 0
            for item in assertions:
                if isinstance(item, dict) and isinstance(item.get("passed"), bool):
                    total_this += 1
                    if item["passed"]:
                        passed_this += 1
            if total_this > 0:
                runs_with_assertions += 1
                total += total_this
                passed += passed_this
        return {
            "runsWithAssertions": runs_with_assertions,
            "totalAssertions": total,
            "passedAssertions": passed,
            "failedAssertions": total - passed,
        }

    def run_trend(
        self, project_id: str, window_days: int | None = None
    ) -> dict[str, Any]:
        """逐日运行/断言趋势（R4-1：编排看板数据源，纯增量端点）。

        口径与 assertion_stats 一致：仅 `status IN ('success','failed')` 的终态 run，
        无断言 run 不进断言分子分母。按 `created_at` 的 UTC 日期（YYYY-MM-DD）分桶；
        近 window_days 天含无数据日（前端图表需要连续 x 轴）。只聚合计数，
        不落 actual 值（无脱敏面）。window_days 为 None 或 <=0 时为全量窗口。
        """
        params: list[Any] = [project_id]
        window_sql = ""
        bounded = window_days is not None and window_days > 0
        empty: dict[str, int] = {
            "runTotal": 0,
            "runPassed": 0,
            "runFailed": 0,
            "assertionTotal": 0,
            "assertionPassed": 0,
        }
        buckets: dict[str, dict[str, Any]] = {}
        if bounded:
            today = datetime.now(timezone.utc).date()
            start = today - timedelta(days=window_days - 1)
            window_sql = "AND created_at >= ?"
            params.append(f"{start.isoformat()}T00:00:00.000Z")
            for offset in range(window_days):
                day = (start + timedelta(days=offset)).isoformat()
                buckets[day] = {"date": day, **empty}
        rows = self.database.execute(
            f"""
            SELECT status, created_at, result FROM platform_runs
            WHERE project_id = ? AND status IN ('success', 'failed')
            {window_sql}
            """,
            tuple(params),
        ).fetchall()

        for status, created_at, result in rows:
            day = created_at[:10] if created_at else None
            if not day:
                continue
            bucket = buckets.get(day)
            if bucket is None:
                if bounded:
                    continue
                bucket = {"date": day, **empty}
                buckets[day] = bucket
            bucket["runTotal"] += 1
            if status == "success":
                bucket["runPassed"] += 1
            else:
                bucket["runFailed"] += 1
            parsed = parse_json(result, None)
            assertions = (
                parsed.get("assertions") if isinstance(parsed, dict) else None
            )
            if isinstance(assertions, list):
                for item in assertions:
                    if isinstance(item, dict) and isinstance(item.get("passed"), bool):
                        bucket["assertionTotal"] += 1
                        if item["passed"]:
                            bucket["assertionPassed"] += 1

        points = [buckets[key] for key in sorted(buckets)]
        return {"windowDays": window_days, "points": points}

    def assertion_failures_for_runs(
        self, runs: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """跨 run 收集失败断言明细（batch detail 的「失败明细列表」数据源）。

        actual 经 redact_run_value 脱敏，与断言载荷脱敏约束一致。
        """
        failures: list[dict[str, Any]] = []
        for run in runs:
            result = as_record(run.get("result"))
            assertions = result.get("assertions") if isinstance(result, dict) else None
            if not isinstance(assertions, list):
                continue
            snapshot = as_record(run.get("snapshot"))
            flow = as_record(snapshot.get("flow"))
            flow_name = str(flow.get("name") or "Published flow")
            for item in assertions:
                if not isinstance(item, dict) or item.get("passed") is not False:
                    continue
                actual = self.redact_run_value(run, item.get("actual"))
                failures.append(
                    {
                        "runId": str(run.get("id") or ""),
                        "flowName": flow_name,
                        "title": str(item.get("title") or "断言"),
                        "type": str(item.get("type") or ""),
                        "expected": str(item.get("expected") or ""),
                        "actual": str(actual) if actual is not None else "",
                    }
                )
        return failures
