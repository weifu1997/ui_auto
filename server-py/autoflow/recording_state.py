"""Process-local browser storage snapshots owned by Platform recording."""

from __future__ import annotations

import threading
from copy import deepcopy
from typing import Any


class RecordingSessionStateStore:
    """Keep detached login snapshots within the supported recording boundary.

    Browser storage can contain credentials, so snapshots stay process-local and
    are scoped to the authenticated owner as well as the project and environment.
    They are deliberately never written to the Platform database.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._states: dict[tuple[str, str, str], dict[str, Any]] = {}

    def state_for(
        self, owner_id: str, project_id: str, environment_id: str
    ) -> dict[str, Any] | None:
        key = (owner_id, project_id, environment_id)
        if not all(key):
            return None
        with self._lock:
            state = self._states.get(key)
            return deepcopy(state) if state is not None else None

    def remember(
        self, session: dict[str, Any], storage_state: dict[str, Any]
    ) -> None:
        owner_id = str(session.get("ownerId") or "")
        project_id = str(session.get("projectId") or "")
        environment_id = str(session.get("environmentId") or "")
        if not all((owner_id, project_id, environment_id)) or not isinstance(
            storage_state, dict
        ):
            return
        with self._lock:
            self._states[(owner_id, project_id, environment_id)] = deepcopy(
                storage_state
            )
