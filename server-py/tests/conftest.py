"""Test-session isolation for import-time side effects.

Since 阶段1-D, `autoflow.main` no longer constructs services on import: the
module-level `app = create_app()` was removed in favor of the explicit
`create_platform_app()` factory (uvicorn `--factory`) plus a lazy module
`__getattr__` that only builds `app` when `autoflow.main:app` is explicitly
referenced. `import autoflow.main` / `from autoflow.main import create_app`
are therefore side-effect free.

The `PLATFORM_DATA_DIRECTORY` redirect below is retained as a harmless safety
net: if anything ever constructs a default `PlatformServices` (un-pointed
data dir) during a test import, it still lands on a throwaway temp directory
instead of the repository's real `data/`. Tests always construct their own
`PlatformServices` on `tmp_path`.
"""

import os
import tempfile

os.environ["PLATFORM_DATA_DIRECTORY"] = tempfile.mkdtemp(prefix="autoflow-test-data-")
# Tests construct PlatformServices without a key file; opt in to the documented
# development default. Production and direct Python startup still fail closed.
os.environ.setdefault("AUTOFLOW_ALLOW_INSECURE_DEV_KEY", "1")
