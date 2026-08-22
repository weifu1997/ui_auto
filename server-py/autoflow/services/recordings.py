"""Recording failure audit and recording login state."""
from __future__ import annotations

from typing import Any


class RecordingServices:
    """Recording failure audit and recording login state."""

    def _audit_recording_failed(self, session: dict[str, Any]) -> None:
        """Record a safe lifecycle summary without exposing browser error details."""
        try:
            project = self.project_for(session["projectId"])
            self.audit(
                project["workspace_id"],
                {"type": "user", "id": session["ownerId"]},
                "recording.session_failed",
                {"type": "recording_session", "id": session["id"]},
                {
                    "flowId": session["flowId"],
                    "environmentId": session["environmentId"],
                    "status": "failed",
                },
                session["projectId"],
            )
        except Exception:
            # Browser startup failures must retain their original error contract.
            pass

    def recording_login_state(
        self, owner_id: str, project_id: str, environment_id: str
    ) -> dict[str, Any] | None:
        return self.recording_session_state.state_for(
            owner_id, project_id, environment_id
        )
