# Run Batch & Recording Contracts

Executable Platform API contracts for serialized run batches and in-memory browser recording sessions.

## Scenario: Serialized Run Batches

### 1. Scope / Trigger

- Trigger: a batch crosses the HTTP handler, revision resolver, SQLite transaction, ManagedRunner, audit trail, and frontend DTO boundary.
- Batch means submission and observation of multiple flows, not parallel execution. Each selected flow creates exactly one queued run.

### 2. Signatures

- `POST /api/platform/projects/{project_id}/run-batches`
- `GET /api/platform/projects/{project_id}/run-batches?page=&pageSize=&status=`
- `GET /api/platform/projects/{project_id}/run-batches/{batch_id}`
- `POST /api/platform/projects/{project_id}/run-batches/{batch_id}/cancel`
- `POST /api/platform/projects/{project_id}/run-batches/{batch_id}/retry-failed`
- Service owners: `PlatformServices.create_run_batch`, `cancel_run_batch`, and `retry_run_batch`.

### 3. Contracts

- Creation input is `{ flowIds, environmentId, clientRequestId }`; the authenticated handler supplies `projectId` and `createdBy` and requires `run.execute`.
- `flowIds` must be 2-20 distinct flows in the project. A batch never accepts request-level dataset or `upToStepId`, and it must also reject a resolved revision with `datasetVersionId`; otherwise a revision default could silently turn one flow into multiple runs.
- Resolve and validate every flow before opening the insert transaction. On success, insert the batch, child runs, and queued events in one transaction; enqueue only after commit.
- Reusing the same `(projectId, clientRequestId)` with the same payload returns the existing batch. A different payload returns `IDEMPOTENCY_KEY_REUSED`.
- List and detail responses expose batch counts plus run summaries only. Do not return execution snapshots or secret values. Batch status is derived from child-run states, never double-written.
- Cancel and retry require `run.execute`. Retry creates a new batch only from terminal failed/canceled children and records `retryOfBatchId` and each child `retryOfRunId`.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Invalid cardinality, duplicate flow, request dataset, or request `upToStepId` | `BATCH_INPUT_NOT_SUPPORTED` or the corresponding input error |
| A flow lacks a valid revision, has no steps, needs an unavailable secret, or its revision has a dataset default | `BATCH_PREFLIGHT_FAILED` with `detail.items[]` containing `flowId` and code; no batch or run is written |
| More than 2000 total steps | `BATCH_TOTAL_STEPS_EXCEEDED` |
| Reused client request key with different environment or flows | `IDEMPOTENCY_KEY_REUSED` |
| Retry before every child is terminal, or with no failed/canceled child | `BATCH_NOT_RETRYABLE` |

### 5. Good / Base / Bad Cases

- Good: two eligible flows resolve to two queued runs in item order and a single batch audit event.
- Base: repeating the same create or retry request returns the pre-existing batch without duplicating runs or audit events.
- Bad: a selected revision has a dataset default. Reject the entire request before any child run is inserted; never silently reuse single-run dataset expansion.

### 6. Tests Required

- `test_run_batches.py`: atomic preflight failure, revision dataset-default rejection, idempotency, aggregate status matrix, pagination, cancel idempotence, and retry lineage/audit.
- Playwright `tests/batch-run.spec.ts`: submit, batch URL selection, child visibility, cancel, retry, and refresh recovery.
- Assert database batch/run counts remain zero for every preflight error and that replays do not duplicate audit records.

### 7. Wrong vs Correct

#### Wrong

```python
# A dataset omitted from the request is treated as an ordinary single-flow batch.
spec = services.resolve_run_spec(request)
insert_run_from_spec(spec)
```

#### Correct

```python
spec = services.resolve_run_spec(request)
if spec["datasetVersionId"]:
    raise PlatformError(400, "BATCH_INPUT_NOT_SUPPORTED")
# Insert only after every selected spec has passed preflight.
```

## Scenario: Browser Recording Sessions

### 1. Scope / Trigger

- Trigger: recording controls cross authenticated Platform routes, an in-memory Playwright session, normalized event cursors, frontend session recovery, and audit logging.
- Sessions are intentionally process-local. Do not persist raw browser events, browser state, selectors, or sensitive input values.

### 2. Signatures

- `POST /api/platform/projects/{project_id}/recording-sessions` with `{ flowId, environmentId, startUrl, freshLogin? }`.
- `GET /api/platform/projects/{project_id}/recording-sessions/{session_id}` and `/events?afterSeq=&limit=`.
- `POST` pause, resume, and stop endpoints below the session; `DELETE` cancels it.
- Service owner: `RecordingCoordinator.create_session`, `events_after`, `pause`, `resume`, `stop`, and `cancel`.

### 3. Contracts

- Every route requires `flow.edit`, project membership, and the owning user. A foreign project/session must not reveal whether the session exists.
- The start URL must be HTTP(S), same-origin with the environment base URL, and free of userinfo. Session and audit URLs are sanitized to scheme, host, and path.
- Events are retrieved incrementally by `afterSeq`; the client deduplicates by `seq` and may store only the session id in `sessionStorage` for control recovery.
- The recording owner thread must remain inside a bounded Playwright sync call after startup so browser binding callbacks from user-idle interactions are dispatched. Stop, cancel, expiry, and browser failure signal the session and let that same owner thread flush results and close Playwright resources; request threads must not close sync objects directly.
- Capture descriptors for click and keyboard events must resolve the closest same-document semantic interactive ancestor (`button`, `a[href]`, form control, or explicit `role`) so nested text/SVG nodes retain the parent testid or role/name locator. Unsupported-feature detection still evaluates the raw event path, preserving the Shadow DOM and contenteditable warning contract.
- Pause is a normalization boundary: flush any pending input before changing status to `paused`, then ignore subsequent business events until resume. This prevents text typed before and after pause from becoming one recorded step.
- Browser page close/disconnect, startup, and navigation failure produce stable failed terminal states and release context, browser, and Playwright resources. Sensitive inputs carry binding metadata only, never their typed value.
- A revision save that contains a password/secret/token-like step may persist only a complete `{{scope.name}}` template reference. Materialized sensitive values are rejected before the revision transaction, so a failed save cannot leave a plaintext snapshot.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Malformed JSON or missing flow/environment id | `RECORDING_INPUT_INVALID` |
| Non-Chromium environment | `RECORDING_ENVIRONMENT_UNSUPPORTED` |
| Second active session for the same owner/project/environment | `RECORDING_SESSION_ACTIVE` |
| Browser start or initial navigation failure | `RECORDING_BROWSER_START_FAILED` or `RECORDING_NAVIGATION_FAILED` |
| Invalid event cursor or limit | `RECORDING_AFTER_SEQ_INVALID` or `RECORDING_LIMIT_INVALID` |
| Browser page closed or browser disconnected | terminal `failed` with `RECORDING_PAGE_CLOSED` or `RECORDING_BROWSER_DISCONNECTED` |

### 5. Good / Base / Bad Cases

- Good: record text, pause, resume, then record more text. The pre-pause text is already a distinct normalized step.
- Base: repeating stop or cancel returns the same terminal session and does not duplicate its audit event.
- Bad: merge input across a pause boundary or report password text in an event/result/audit payload. Both violate lifecycle and redaction contracts.

### 6. Tests Required

- `test_recording_sessions.py`: normalization, pause boundary, expiration, launch/navigation failure, close/disconnect cleanup, and real-browser login-state teardown.
- `test_recording_sessions.py`: the real Chromium coordinator case must trigger input/click after `create_session` returns without issuing another page command, then assert seq, preview steps, and same-thread teardown.
- `test_recorder_poc.py`: nested text and SVG-path clicks must produce steps that reference their button/link parent locators, then replay successfully.
- `test_recording_api.py`: capability/project scoping, malformed JSON, and terminal audit idempotence.
- Playwright `tests/recording.spec.ts`: session recovery, pause/resume controls, review, locator validation, and atomic draft import.
- Assert every sensitive test value is absent from captured payloads and serialized outputs.

### 7. Wrong vs Correct

#### Wrong

```python
if session["status"] == "recording":
    session["status"] = "paused"
```

#### Correct

```python
if session["status"] == "recording":
    session["normalizer"].flush_pending()
    session["status"] = "paused"
```
