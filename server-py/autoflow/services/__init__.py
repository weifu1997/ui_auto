"""Service layer composed from domain mixins; the public surface stays PlatformServices, AuthUser and BOOTSTRAP_SCHEMA."""
from __future__ import annotations

from ._shared import BOOTSTRAP_SCHEMA, AuthUser
from .core import CoreServices
from .recordings import RecordingServices
from .secrets import SecretServices
from .webhooks import WebhookServices
from .identity import IdentityServices
from .workspaces import WorkspaceServices
from .membership import MembershipServices
from .datasets import DatasetServices
from .revisions import RevisionServices
from .agents import AgentServices
from .notifications import NotificationServices
from .runs import RunServices
from .batches import BatchServices
from .validations import ValidationServices
from .retention import RetentionServices
from .analytics import AnalyticsServices
from .schedules import ScheduleServices


class PlatformServices(
    CoreServices,
    RecordingServices,
    SecretServices,
    WebhookServices,
    IdentityServices,
    WorkspaceServices,
    MembershipServices,
    DatasetServices,
    RevisionServices,
    AgentServices,
    NotificationServices,
    RunServices,
    BatchServices,
    ValidationServices,
    RetentionServices,
    AnalyticsServices,
    ScheduleServices,
):
    """Composed service object; construction and shutdown live in CoreServices."""

