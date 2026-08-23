"""Test-session isolation for import-time side effects.

`autoflow.main` defines a module-level `app = create_app()` so uvicorn can load
`autoflow.main:app`. Importing that module in a test therefore constructs a
real `PlatformServices` pointed at the repository's `data/` directory, running
migrations, starting ManagedRunner threads, and re-enqueueing queued runs.

conftest is imported before any test module, so redirecting
`PLATFORM_DATA_DIRECTORY` here keeps that side-effectful instance away from
real data. Tests always construct their own `PlatformServices` on `tmp_path`,
so this only affects the module-level app that tests never assert against.
"""

import os
import tempfile

os.environ["PLATFORM_DATA_DIRECTORY"] = tempfile.mkdtemp(prefix="autoflow-test-data-")
