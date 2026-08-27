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

## Scenario: Run Record Deletion

### 1. Scope / Trigger

- Trigger: deleting one or more run records crosses the Runs page, Platform API, service transaction, project boundary, dependent run tables, and audit trail.

### 2. Signatures

- `DELETE /api/platform/projects/{project_id}/runs/{run_id}`
- `POST /api/platform/projects/{project_id}/runs/batch-delete` with `{ runIds: string[] }` (1-100 entries).
- Service owners: `PlatformServices.delete_run(project_id, run_id)` and `delete_runs(project_id, run_ids)`.

### 3. Contracts

- Both routes require `run.execute`. Only terminal runs (`success`, `failed`, `canceled`) are deletable; queued/running work must first use the cancel lifecycle.
- Resolve the deletable ID set with both `project_id` and terminal status before deleting anything. Use that resolved set for `deliveries`, `flow_outputs`, `platform_artifacts`, `platform_run_events`, and `platform_runs`; never use raw request IDs for dependent-table deletes.
- Single delete returns `{ runId, deleted: true }`. Batch delete returns only IDs actually deleted: `{ runIds, deletedCount }`.
- A successful delete writes `run.deleted` with IDs/count only. The frontend updates local state only after API success and must surface API failure instead of reporting a false success.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Empty/non-array `runIds`, blank ID, malformed JSON, or more than 100 IDs | `RUN_DELETE_INPUT_INVALID` |
| Single run is absent or belongs to another project | `RUN_NOT_FOUND` |
| Single run is queued/running | `RUN_NOT_DELETABLE` (409) |
| Batch includes absent, foreign-project, or active IDs | Skip those IDs; return only the terminal current-project IDs actually deleted |

### 5. Good / Base / Bad Cases

- Good: deleting terminal runs removes their events/artifacts and returns the deleted IDs/count.
- Base: a stale batch containing missing IDs deletes the remaining eligible current-project records without inventing success for skipped IDs.
- Bad: deleting dependent rows using raw request IDs can erase another project's events/artifacts even when the final `platform_runs` delete is project-scoped.

### 6. Tests Required

- `test_batch_delete_runs.py`: route availability, capability path, single/batch responses, active-run rejection, dependent-row cleanup, and foreign-project preservation.
- `batch-delete.test.tsx`: terminal selection and visible single/batch commands; add a rejection case whenever Runs page error handling changes.
- Assert the UI does not remove local rows or show success after a Platform delete rejects.

### 7. Wrong vs Correct

#### Wrong

```python
database.execute("DELETE FROM platform_run_events WHERE run_id IN (...)" , request_run_ids)
database.execute("DELETE FROM platform_runs WHERE project_id = ? AND id IN (...)" , params)
```

#### Correct

```python
deletable_ids = select_terminal_run_ids(project_id, request_run_ids)
delete_run_dependencies(deletable_ids)
delete_project_runs(project_id, deletable_ids)
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
- Playwright `e2e/recording.spec.ts`: session recovery, pause/resume controls, review, locator validation, and atomic draft import.
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

## Scenario: Element Validation Login-State Reuse

### 1. Scope / Trigger

- Trigger: element-locator validation (`POST /element-validations`) targets a page behind a login wall. The recorder captures such pages while logged in; a validation that opens them anonymously can never match the element.
- The recorder's `storage_state` snapshot lives only in process memory (`RecordingSessionStateStore`), keyed by `(ownerId, projectId, environmentId)`.

### 2. Signatures

- Service owner: `PlatformServices.create_element_validation` looks up `recording_session_state.state_for(created_by, project_id, environment_id)` and passes it to `enqueue_managed_validation(validation, environment, storage_state)`, which puts it under `input["storage_state"]` for `execute_element_validation`.
- Runner owner: `execute_element_validation` applies the snapshot to the browser context, then classifies a login wall via the pure helper `runner._element_validation_login_error(element, login_detected, storage_state)`.

### 3. Contracts

- The snapshot is scoped to the requesting user (`created_by`); another owner's snapshot for the same project/environment must never be injected.
- After navigating to the element path, if the page shows a login wall (login-ish `location.pathname` or a password input), validation fails with a stable, actionable code instead of a silent `count=0` "missed":
  - `ELEMENT_VALIDATION_LOGIN_REQUIRED` — no stored snapshot for this owner/project/environment.
  - `ELEMENT_VALIDATION_LOGIN_INVALID` — a snapshot was injected but the wall still appears (stale session).
- Elements whose own `path` is a login page (contains `login`, `log-in`, `signin`, `sign-in`, `auth`, or `account`, case-insensitive) are exempt from the wall check so the login button itself validates normally.
- The frontend maps these codes to actionable Chinese copy (`src/element-validation.ts`); a failed validation must surface as `error` (never as `missed`), and a batch with login-blocked elements renders a warning alert above the element list.
- Because the snapshot is process-local and lost on restart, "record then validate immediately" is the supported flow; the cold-start case must surface `*_REQUIRED`/`*_INVALID`, not hang or silently pass.
- Frontend contract (`src/recording-editor-state.ts`): new-element ids in the import plan must be derived deterministically from the locator key (`recordedElementId(elementKey(...))`), never from a plan timestamp. The plan is recomputed every time the workspace synchronizer re-fetches the element store (30s poll → new array refs), and any id churn orphans in-flight validation results keyed to the previous ids, leaving the UI stuck at "校验中".
- Frontend polling must outlive the worst-case server-side wait: validations execute serially per workspace and a single task can take ~50s, so the recording-result poller runs 900 × 500ms (7.5 min), matching the Elements page. A shorter cap silently abandons the poll while the server task still completes, and the row shows a terminal status only after the user manually re-triggers.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| No login wall on target page | normal count-based success/ambiguous/missed result |
| Login wall, no snapshot for requesting owner | `failed` with `ELEMENT_VALIDATION_LOGIN_REQUIRED` |
| Login wall, snapshot injected but still on wall | `failed` with `ELEMENT_VALIDATION_LOGIN_INVALID` |
| Element path is a login page | wall check skipped; validate as usual |

### 5. Good / Base / Bad Cases

- Good: record a dashboard flow while logged in, stop, then validate a dashboard element — the recorder snapshot is injected and the element matches.
- Base: validating an element on `/login` without any snapshot succeeds as before (exempt path).
- Bad: falling back to `count=0`/"missed" when the page is actually a login wall, or leaking owner B's snapshot into owner A's validation.

### 6. Tests Required

- `server-py/tests/unit/test_element_validation_login.py`: decision matrix of `_element_validation_login_error` (wall present/absent, snapshot present/absent, exempt login paths), snapshot injection into the runner input via `enqueue_managed_validation`, and owner-scoped snapshot isolation.
- `src/element-validation.test.ts`: mapping of both error codes to user-facing messages.
- Playwright `e2e/recording.spec.ts` stays green: its recorded element sits on the `/login` path, which is exempt from the wall check.

### 7. Wrong vs Correct

#### Wrong

```python
# Anonymous validation of a protected page, then a misleading "missed".
result = {"status": "success", "count": 0}  # page was actually a login wall
```

#### Correct

```python
if login_detected and not element_path_is_login_page:
    if input.get("storage_state"):
        raise RuntimeError("ELEMENT_VALIDATION_LOGIN_INVALID")
    raise RuntimeError("ELEMENT_VALIDATION_LOGIN_REQUIRED")
```

## Scenario: Integrity Hardening Contracts (W0–W2, 2026-08-27)

### 1. Sensitive Word List Single Source
- 唯一权威词表：`server-py/autoflow/sensitive.py`。浏览器注入脚本的正则由 `RECORDER_INIT_SCRIPT` 模板占位符替换生成；服务端判定 `is_sensitive_field` 直接委托。新增敏感词（含中文）只允许改这里，禁止在前后端各自复制正则。
- 中文标签输入属于该契约范围：历史上前端词表含中文而服务端不含，造成明文经 GET events 外泄。回归锚点：`tests/unit/test_text_and_sensitive_fidelity.py::test_chinese_labeled_input_value_never_persists`。

### 2. Run Finalize Transactional Contract
- 终态落库唯一入口 `PlatformServices.finalize_completed_run(run_id, result)`：状态 UPDATE、flowOutputs、run.complete、审计、投递登记必须在同一 BEGIN IMMEDIATE 内提交；投递的 **网络发送** 用 `queue_run_deliveries(..., flush=False)` 只入队，COMMIT 之后统一 `deliver_pending_notifications()`。
- 迟到成功兜底：行已被 watchdog 判死（failed）后收到 success 结果 → `absorb_late_completed_run` 补产物与 `run.lateCompletion` 事件，状态不回改。

### 3. Heartbeat & Watchdog & Cancellation Marker
- ManagedRunner hooks 增加 `progress(stepIndex)`：每步开始触发 `touch_run_heartbeat` 仅刷新 running 行 updated_at（不发事件流）。watchdog 窗口由环境变量 `RUN_WATCHDOG_MINUTES` 控制（默认 20，钳制 [5,240]），判定语义是"无步进超窗"。
- 取消标记先行：`request_run_cancel` 无条件对 queued/running 写 `cancellation_requested=1` 再把仍 queued 的置 canceled；禁止回退为"先读后分支写"。
- 「等待」步骤硬上限 `WAIT_STEP_MAX_MS`（默认 10 分钟，下限 1 秒），保证取消最坏延迟有界；截断发 `step.waitCapped`。

### 4. Frontend: Persistent Run Dispatch Keys
- `RunDispatchKeyMap`（src/pages/shared.tsx）：按用户分区持久化到 localStorage（base 键见 `RUN_DISPATCH_KEY_STORAGE`，TTL 24h）。五处调用统一 `createRunDispatchKeyStore()` 构造；新增运行入口不得再用裸 `new Map()`。登出清理经 account-state-reset 的 userScopedBases。
