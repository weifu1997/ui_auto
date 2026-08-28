"""Assertion report export (JSON/XLSX) as run artifacts."""
from __future__ import annotations

import json as _json
import uuid
from typing import Any
from ...core import now, safe_artifact_name
from ...resources import as_record

class _ReportMixin:
    """Assertion report export."""

    def build_assertion_report(
        self, run_id: str, run_format: str
    ) -> dict[str, Any]:
        """装配断言报告并登记为 run 的 artifact（JSON/XLSX）。

        数据源：run.result.assertions + 同 run 的失败截图/trace artifact 引用
        （截图名 `failure-step-{序号}.png`、trace 名 `trace.zip`，缺失留空不报错）。
        actual 经 redact_run_value 脱敏。无断言 raise 409。
        """
        from ...http import PlatformError

        run = self.run_by_id(run_id)
        result = as_record(run.get("result"))
        assertions = result.get("assertions") if isinstance(result, dict) else None
        if not isinstance(assertions, list) or not assertions:
            raise PlatformError(409, "RUN_HAS_NO_ASSERTIONS")

        artifact_rows = self.database.execute(
            """
            SELECT id, name, content_type, path FROM platform_artifacts
            WHERE run_id = ? ORDER BY created_at ASC
            """,
            (run_id,),
        ).fetchall()
        screenshots: dict[str, str] = {}
        trace_id: str | None = None
        for artifact_id, name, _content_type, _path in artifact_rows:
            if name.startswith("failure-step-") and name.endswith(".png"):
                stem = name[len("failure-step-"):][:-len(".png")]
                if stem.isdigit():
                    screenshots[stem] = artifact_id
            elif name == "trace.zip":
                trace_id = artifact_id

        snapshot = as_record(run.get("snapshot"))
        flow = as_record(snapshot.get("flow"))
        environment = as_record(snapshot.get("environment"))
        rows: list[dict[str, Any]] = []
        for item in assertions:
            if not isinstance(item, dict) or not isinstance(item.get("passed"), bool):
                continue
            step_index = int(item.get("stepIndex") or 0)
            actual = self.redact_run_value(run, item.get("actual"))
            rows.append(
                {
                    "stepIndex": step_index,
                    "stepId": str(item.get("stepId") or ""),
                    "title": str(item.get("title") or "断言"),
                    "type": str(item.get("type") or ""),
                    "passed": item["passed"],
                    "expected": str(item.get("expected") or ""),
                    "actual": str(actual) if actual is not None else "",
                    "durationMs": int(item.get("durationMs") or 0),
                    "screenshotArtifactId": screenshots.get(str(step_index + 1)),
                    "traceArtifactId": trace_id,
                }
            )
        report = {
            "runId": run_id,
            "flowName": str(flow.get("name") or "Published flow"),
            "environmentName": str(environment.get("name") or ""),
            "status": run["status"],
            "generatedAt": now(),
            "assertionCount": len(rows),
            "assertions": rows,
        }

        if run_format == "xlsx":
            content_type = (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            )
            extension = "xlsx"
            data = self._assertion_report_xlsx(report)
        elif run_format == "html":
            content_type = "text/html; charset=utf-8"
            extension = "html"
            data = self._assertion_report_html(report)
        else:
            content_type = "application/json"
            extension = "json"
            data = _json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8")

        artifact_directory = self.managed_runner.artifact_directory
        artifact_directory.mkdir(parents=True, exist_ok=True)
        artifact_name = safe_artifact_name(f"assertion-report-{run_id}.{extension}")
        artifact_path = artifact_directory / artifact_name
        artifact_path.write_bytes(data)
        artifact_id = str(uuid.uuid4())
        created_at = now()
        self.database.execute(
            """
            INSERT INTO platform_artifacts (
              id, run_id, project_id, name, content_type, path, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                artifact_id,
                run_id,
                run["projectId"],
                artifact_name,
                content_type,
                str(artifact_path),
                created_at,
            ),
        )
        return {
            "artifact": {
                "id": artifact_id,
                "name": artifact_name,
                "contentType": content_type,
                "createdAt": created_at,
            }
        }

    def _assertion_report_xlsx(self, report: dict[str, Any]) -> bytes:
        import io

        from openpyxl import Workbook
        from openpyxl.styles import Font

        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "断言报告"
        sheet.append(["序号", "步骤", "类型", "判定", "期望", "实际", "耗时(ms)", "失败截图", "Trace"])
        for cell in sheet[1]:
            cell.font = Font(bold=True)
        for row in report["assertions"]:
            sheet.append(
                [
                    int(row["stepIndex"]) + 1,
                    row["title"],
                    row["type"],
                    "通过" if row["passed"] else "失败",
                    row["expected"],
                    row["actual"],
                    int(row["durationMs"]),
                    row["screenshotArtifactId"] or "",
                    row["traceArtifactId"] or "",
                ]
            )
        buffer = io.BytesIO()
        workbook.save(buffer)
        return buffer.getvalue()

    def _assertion_report_html(self, report: dict[str, Any]) -> bytes:
        """渲染自包含 HTML 断言报告。

        自包含（无外链资源）、所有字段 html.escape 转义防注入；
        actual 沿用 build_assertion_report 的 redact_run_value 脱敏结果，
        故 HTML 产物同样不写明文 secret。
        """
        import html

        esc = html.escape
        rows = report["assertions"]
        passed = sum(1 for row in rows if row["passed"])
        total = len(rows)
        body_rows = []
        for index, row in enumerate(rows, start=1):
            body_rows.append(
                f'<tr class="{"passed" if row["passed"] else "failed"}">'
                f"<td>{index}</td>"
                f"<td>{esc(str(row['title']))}</td>"
                f"<td>{esc(str(row['type']))}</td>"
                f'<td>{"通过" if row["passed"] else "失败"}</td>'
                f"<td><code>{esc(str(row['expected']))}</code></td>"
                f"<td><code>{esc(str(row['actual']))}</code></td>"
                f"<td>{int(row['durationMs'])}</td>"
                "</tr>"
            )
        # 模板用 @@TOKEN@@ 占位 + str.replace 填充：避免 CSS 花括号与 str.format 冲突。
        document = (
            "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n"
            "<meta charset=\"utf-8\" />\n"
            "<title>断言报告 · @@TITLE@@</title>\n"
            "<style>"
            "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"
            "margin:2rem auto;max-width:960px;padding:0 1rem;color:#1f2328;}"
            "h1{font-size:1.25rem;}.meta{color:#57606a;font-size:.875rem;"
            "margin-bottom:1rem;}.summary{font-size:.875rem;margin-bottom:1rem;}"
            "table{width:100%;border-collapse:collapse;font-size:.875rem;}"
            "th,td{border:1px solid #d0d7de;padding:.5rem .625rem;text-align:left;}"
            "th{background:#f6f8fa;}tr.failed td{background:#ffebe9;}"
            "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;"
            "font-size:.8125rem;}"
            "</style>\n</head>\n<body>\n"
            "<h1>断言报告 · @@TITLE@@</h1>\n"
            "<div class=\"meta\">Run @@RUN_ID@@ · 环境 @@ENV@@ · 状态 @@STATUS@@ · "
            "生成于 @@GENERATED_AT@@</div>\n"
            "<div class=\"summary\">@@PASSED@@/@@TOTAL@@ 通过</div>\n"
            "<table><thead><tr><th>序号</th><th>步骤</th><th>类型</th><th>判定</th>"
            "<th>期望</th><th>实际</th><th>耗时(ms)</th></tr></thead><tbody>\n"
            "@@ROWS@@\n"
            "</tbody></table>\n</body>\n</html>\n"
        )
        substitutions = {
            "@@TITLE@@": esc(str(report["flowName"])),
            "@@RUN_ID@@": esc(str(report["runId"])),
            "@@ENV@@": esc(str(report["environmentName"])),
            "@@STATUS@@": esc(str(report["status"])),
            "@@GENERATED_AT@@": esc(str(report["generatedAt"])),
            "@@PASSED@@": str(passed),
            "@@TOTAL@@": str(total),
            "@@ROWS@@": "\n".join(body_rows),
        }
        for token, value in substitutions.items():
            document = document.replace(token, value)
        return document.encode("utf-8")
