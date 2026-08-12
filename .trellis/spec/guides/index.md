# Thinking Guides

> **Purpose**: Expand your thinking to catch things you might not have considered.

---

## Why Thinking Guides?

**Most bugs and tech debt come from "didn't think of that"**, not from lack of skill:

- Didn't think about what happens at layer boundaries → cross-layer bugs
- Didn't think about code patterns repeating → duplicated code everywhere
- Didn't think about edge cases → runtime errors
- Didn't think about future maintainers → unreadable code

These guides help you **ask the right questions before coding**.

---

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Identify patterns and reduce duplication | When you notice repeated patterns |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Think through data flow across layers | Features spanning multiple layers |

---

## Quick Reference: Thinking Triggers

### When to Think About Cross-Layer Issues

- [ ] Feature touches 3+ layers (API, Service, Component, Database)
- [ ] Data format changes between layers
- [ ] Multiple consumers need the same data
- [ ] You're not sure where to put some logic
- [ ] You are adding an event kind, JSONL record, RPC payload, or config field
- [ ] UI / command code starts casting raw payload fields directly

→ Read [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md)

### When to Think About Code Reuse

- [ ] You're writing similar code to something that exists
- [ ] You see the same pattern repeated 3+ times
- [ ] You're adding a new field to multiple places
- [ ] **You're modifying any constant or config**
- [ ] **You're creating a new utility/helper function** ← Search first!
- [ ] Two files read the same untyped payload field with local casts
- [ ] Multiple branches update the same derived state from `kind` / `action`

→ Read [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md)

### When Backing Up / Resetting a Local SQLite Database

- [ ] Copy **all three files** (`x.sqlite` + `x.sqlite-wal` + `x.sqlite-shm`) into the timestamped backup dir — a live DB keeps most recent data in the WAL; copying only the main file is NOT recoverable (real case 2026-08-10: `platform.sqlite` was 4 KB while 1.7 MB lived in the WAL)
- [ ] Only delete the DB the task authorizes (e.g. `platform.sqlite`), never `autoflow.sqlite` or unrelated worktree changes; never delete the backup dir
- [ ] Reset is the only recovery for a lost Platform account — password hashes are unrecoverable and there is no delete-account API; test accounts created during verification stay in the local DB
- [ ] Restart the service, then verify the full closure before declaring done: `POST /api/auth/register` (201) → session restore via cookie (200) → `GET /health` (online)

### When Removing a Feature / Subsystem

- [ ] Grep every reference (API functions, types, routes, UI labels, tests, docs) before deleting — `AgentRecord`/`debug-*`/`lease` style symbol names spread across server, src, tests (real case 2026-08-13: Agent 远程执行裁剪扫出 20+ 引用文件)
- [ ] Delete in dependency order: child tables before parent tables; client modules before their consumers
- [ ] Keep shared kernels that other paths still use (e.g. `runner-core` / `picker-core` stay even when the agent protocol dies); check reverse references (`platform-core.safeArtifactName` used by legacy worker)
- [ ] Run the full gate (`build / lint / test:unit / test:platform / test:managed / test:worker / test:e2e / test:production / test:windows`) and fix every dead-code lint/TS error, then update README/docs in the same batch

### When Verifying AI Cross-Review Results

- [ ] Reviewer claims "user input can be malicious" → Check the actual data source (internal manifest? user config? external API?)
- [ ] Reviewer flags "missing validation" → Is the data from a trusted internal source?
- [ ] Reviewer says "behavior change" → Read the code comments — is it intentional design?
- [ ] Reviewer identifies a "bug" in test → Mentally delete the feature being tested — does the test still pass? If yes → tautological test

**Common AI reviewer false-positive patterns**:
1. **Trust boundary confusion**: Treating internal data (bundled JSON manifests) as untrusted external input
2. **Ignoring design comments**: Flagging intentional behavior documented in code comments as bugs
3. **Variable misreading**: Not tracing a variable to its actual definition (e.g., Map keyed by path vs name)

**Verification rule**: Every CRITICAL/WARNING finding must be verified against the actual code before prioritizing. Budget ~35% false-positive rate for AI reviews.

---

## Pre-Modification Rule (CRITICAL)

> **Before changing ANY value, ALWAYS search first!**

```bash
# Search for the value you're about to change
grep -r "value_to_change" .
```

This single habit prevents most "forgot to update X" bugs.

---

## How to Use This Directory

1. **Before coding**: Skim the relevant thinking guide
2. **During coding**: If something feels repetitive or complex, check the guides
3. **After bugs**: Add new insights to the relevant guide (learn from mistakes)

---

## Contributing

Found a new "didn't think of that" moment? Add it to the relevant guide.

---

**Core Principle**: 30 minutes of thinking saves 3 hours of debugging.
