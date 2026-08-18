# Implementation Plan: Persistent Recording Event Pump

1. Add explicit readiness/future state to a recording session and refactor browser startup into a long-lived recording-thread task.
2. Pump the Playwright sync connection at a short bounded interval while the session is active; guarantee thread-local teardown in `finally`.
3. Adapt stop, cancel, expiry and failure paths to signal and await the browser task without submitting teardown behind a running event pump.
4. Add a delayed-event fixture and real Chromium test that proves binding events arrive after startup returns while no page-driving command runs.
5. Run focused recorder tests, full Python tests, lint, build, unit tests and recording Playwright regression. Verify no browser processes remain.

## Risky Areas

- `stop` must not block forever if the event pump throws or the page has already closed.
- Existing test submitters use immediate futures; they must remain valid for pure lifecycle unit tests while the production executor path gains a long-lived task.
- Sensitive event filtering remains at `validate_recorder_event`; no pump instrumentation may log browser payloads.
