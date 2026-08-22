"""Project analytics aggregation."""
from __future__ import annotations

from typing import Any
from ..core import failure_category, parse_json
from ._shared import (
    _fetch_runs,
    _iso_add_seconds,
    _iso_from_ms,
    _iso_ms,
    _period_key,
    _summarize_runs,
)


class AnalyticsServices:
    """Project analytics aggregation."""

    def project_analytics(
        self,
        project_id: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        options = options or {}
        period = "week" if options.get("period") == "week" else "day"
        category_by = options.get("categoryBy")
        if category_by not in ("code", "step"):
            category_by = "message"
        window_days = options.get("windowDays")
        from_iso = options.get("from")
        if from_iso is None and window_days:
            from_iso = _iso_add_seconds(-int(window_days) * 86400)
        to_iso = options.get("to")
        limit = options.get("limit")
        if limit is not None:
            limit = min(2000, max(1, int(limit)))
        runs = _fetch_runs(
            self.database, project_id, from_iso, to_iso, limit or 2000
        )
        events_by_run: dict[str, list[dict[str, Any]]] = {}
        for run in runs:
            rows = self.database.execute(
                """
                SELECT kind, data, created_at FROM platform_run_events
                WHERE run_id = ? ORDER BY id ASC
                """,
                (run["id"],),
            ).fetchall()
            events_by_run[run["id"]] = [
                {
                    "kind": row[0],
                    "data": parse_json(row[1], {}),
                    "at": row[2],
                }
                for row in rows
            ]

        trend: dict[str, dict[str, Any]] = {}
        categories: dict[str, int] = {}
        slow_steps: dict[str, dict[str, Any]] = {}
        elements: dict[str, dict[str, Any]] = {}
        durations: dict[str, dict[str, Any]] = {}
        for run in runs:
            date = _period_key(run["created_at"], period)
            point = trend.setdefault(
                date,
                {"date": date, "total": 0, "success": 0, "failed": 0, "canceled": 0},
            )
            point["total"] += 1
            if run["status"] == "success":
                point["success"] += 1
            elif run["status"] == "failed":
                point["failed"] += 1
            elif run["status"] == "canceled":
                point["canceled"] += 1

            events = events_by_run.get(run["id"], [])
            first = events[0] if events else None
            terminal = next(
                (
                    event
                    for event in reversed(events)
                    if event["kind"]
                    in ("run.complete", "run.failed", "run.interrupted")
                ),
                None,
            )
            if first and terminal:
                start_ms = _iso_ms(first["at"])
                end_ms = _iso_ms(terminal["at"])
                if start_ms is not None and end_ms is not None and end_ms >= start_ms:
                    duration_point = durations.setdefault(
                        date, {"date": date, "totalMs": 0, "count": 0}
                    )
                    duration_point["totalMs"] += end_ms - start_ms
                    duration_point["count"] += 1

            failure = next(
                (
                    event
                    for event in reversed(events)
                    if event["kind"] == "run.failed" or "error" in event["kind"]
                ),
                None,
            )
            if failure:
                data = failure["data"]
                if category_by == "step":
                    category = str(data.get("stepId") or "unknown")
                elif category_by == "code":
                    category = failure_category(
                        data.get("message"), data.get("code")
                    )
                else:
                    category = failure_category(data.get("message"))
                categories[category] = categories.get(category, 0) + 1

            for event in events:
                if event["kind"] not in ("step.completed", "step.succeeded"):
                    continue
                duration_ms = event["data"].get("durationMs")
                try:
                    duration_ms = float(duration_ms)
                except (TypeError, ValueError):
                    continue
                if duration_ms < 0:
                    continue
                step_id = str(event["data"].get("stepId") or "unknown")
                current = slow_steps.setdefault(
                    step_id,
                    {
                        "stepId": step_id,
                        "title": str(event["data"].get("title") or step_id),
                        "totalMs": 0,
                        "maxMs": 0,
                        "count": 0,
                    },
                )
                current["totalMs"] += duration_ms
                current["maxMs"] = max(current["maxMs"], duration_ms)
                current["count"] += 1

            snapshot = parse_json(run["snapshot"], {})
            flow = snapshot.get("flow") if isinstance(snapshot, dict) else {}
            if not isinstance(flow, dict):
                flow = {}
            step_definitions = flow.get("steps", [])
            if not isinstance(step_definitions, list):
                step_definitions = []
            element_definitions = snapshot.get("elements", [])
            if not isinstance(element_definitions, list):
                element_definitions = []
            failed_step_ids = {
                str(event["data"].get("stepId") or "")
                for event in events
                if event["kind"] == "run.failed"
            }
            for raw_step in step_definitions:
                step = raw_step if isinstance(raw_step, dict) else {}
                reference = step.get("element")
                if not isinstance(reference, str):
                    reference = step.get("elementId")
                if not isinstance(reference, str) or not reference:
                    continue
                definition = next(
                    (
                        item
                        for item in element_definitions
                        if isinstance(item, dict)
                        and (
                            item.get("id") == reference
                            or item.get("name") == reference
                        )
                    ),
                    None,
                )
                if isinstance(definition, dict):
                    element_id = (
                        definition.get("id")
                        if isinstance(definition.get("id"), str)
                        else reference
                    )
                    name = (
                        definition.get("name")
                        if isinstance(definition.get("name"), str)
                        else reference
                    )
                else:
                    element_id = reference
                    name = reference
                current_element = elements.setdefault(
                    element_id,
                    {
                        "elementId": element_id,
                        "name": name,
                        "runCount": 0,
                        "flowCount": set(),
                        "failedRuns": 0,
                        "lastUsedAt": run["created_at"],
                    },
                )
                current_element["runCount"] += 1
                current_element["flowCount"].add(run["revision_id"])
                if str(step.get("id") or "") in failed_step_ids:
                    current_element["failedRuns"] += 1
                if run["created_at"] > current_element["lastUsedAt"]:
                    current_element["lastUsedAt"] = run["created_at"]

        previous = None
        from_ms = _iso_ms(from_iso) if from_iso else None
        to_ms = _iso_ms(to_iso) if to_iso else None
        if (
            from_ms is not None
            and to_ms is not None
            and to_ms > from_ms
        ):
            previous = _summarize_runs(
                _fetch_runs(
                    self.database,
                    project_id,
                    _iso_from_ms(from_ms - (to_ms - from_ms)),
                    from_iso,
                )
            )
        elif from_ms is not None and options.get("windowDays"):
            previous = _summarize_runs(
                _fetch_runs(
                    self.database,
                    project_id,
                    _iso_from_ms(from_ms - int(options["windowDays"]) * 86400000),
                    from_iso,
                )
            )
        elif limit and runs:
            previous = _summarize_runs(
                _fetch_runs(
                    self.database, project_id, None, runs[-1]["created_at"], limit
                )
            )

        schedule_params: list[Any] = [project_id, from_iso or "1970-01-01T00:00:00.000Z"]
        schedule_query = """
            SELECT action, COUNT(*) AS count FROM audit_events
            WHERE project_id = ? AND action IN ('schedule.triggered', 'schedule.skipped')
              AND created_at >= ?
        """
        if to_iso:
            schedule_query += " AND created_at <= ?"
            schedule_params.append(to_iso)
        schedule_query += " GROUP BY action"
        schedule_rows = self.database.execute(
            schedule_query, tuple(schedule_params)
        ).fetchall()
        triggered = 0
        skipped = 0
        for row in schedule_rows:
            if row[0] == "schedule.triggered":
                triggered = int(row[1])
            elif row[0] == "schedule.skipped":
                skipped = int(row[1])
        schedule_total = triggered + skipped

        return {
            "summary": _summarize_runs(runs),
            "previous": previous,
            "trend": sorted(trend.values(), key=lambda item: item["date"])[-30:],
            "failureCategories": sorted(
                (
                    {"category": category, "count": count, "dimension": category_by}
                    for category, count in categories.items()
                ),
                key=lambda item: item["count"],
                reverse=True,
            ),
            "slowSteps": sorted(
                (
                    {
                        "stepId": item["stepId"],
                        "title": item["title"],
                        "count": item["count"],
                        "averageMs": round(item["totalMs"] / item["count"]),
                        "maxMs": item["maxMs"],
                    }
                    for item in slow_steps.values()
                ),
                key=lambda item: item["averageMs"],
                reverse=True,
            )[:20],
            "elementImpact": sorted(
                (
                    {
                        "elementId": item["elementId"],
                        "name": item["name"],
                        "runCount": item["runCount"],
                        "flowCount": len(item["flowCount"]),
                        "failedRuns": item["failedRuns"],
                        "lastUsedAt": item["lastUsedAt"],
                    }
                    for item in elements.values()
                ),
                key=lambda item: item["runCount"],
                reverse=True,
            )[:100],
            "runDurations": sorted(
                (
                    {
                        "date": item["date"],
                        "averageMs": round(item["totalMs"] / item["count"]),
                        "count": item["count"],
                    }
                    for item in durations.values()
                ),
                key=lambda item: item["date"],
            )[-30:],
            "scheduleHealth": {
                "triggered": triggered,
                "skipped": skipped,
                "successRate": round((triggered / schedule_total) * 100)
                if schedule_total
                else 0,
            },
        }
