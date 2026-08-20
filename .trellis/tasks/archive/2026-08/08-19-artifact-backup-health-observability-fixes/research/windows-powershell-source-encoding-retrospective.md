## Bug Analysis: Windows PowerShell Source Encoding

### 1. Root Cause Category

- **Category**: E - Implicit Assumption, with a D - Test Coverage Gap.
- **Specific Cause**: `scripts/install.ps1` and `scripts/upgrade.ps1` were
  UTF-8 files without a BOM and contained non-ASCII literals. GitHub's
  Windows PowerShell 5.1 runner parsed the source through a legacy code-page
  path, so a byte sequence could become parser-significant punctuation. The
  first remote Phase 0 run therefore failed during `Parser::ParseFile` with an
  unterminated string / block error, despite a local parser pass.

### 2. Why Fixes Failed (if applicable)

1. **Initial Phase 0 local validation**: the local PowerShell configuration
   parsed the files, so it did not represent the hosted Windows PowerShell 5.1
   decoding behavior.
2. **Existing smoke parser scan**: it checked syntax after host decoding but
   did not assert the portable source-byte contract, allowing a host-specific
   parse result to stand in for portability.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Runtime compatibility | Keep deployment `scripts/*.ps1` source ASCII-only. | DONE |
| P0 | Test coverage | Make Windows smoke reject non-ASCII source bytes before parsing every PowerShell script. | DONE |
| P0 | Hosted integration | Require `deployment-windows` to run `npm run test:windows` on `windows-latest`. | DONE after the retry is green |
| P1 | Documentation | Record the source-encoding contract in the production startup spec. | DONE |

### 4. Systematic Expansion

- **Similar Issues**: the repository scan found the same non-ASCII source
  pattern in `install.ps1` and `upgrade.ps1`; both were made ASCII-only.
- **Design Improvement**: source compatibility is now an explicit byte-level
  contract rather than an incidental behavior of the current editor or local
  shell configuration.
- **Process Improvement**: the remote Windows job remains the authoritative
  portability check; a local pass alone is not release evidence for deployment
  scripts.

### 5. Knowledge Capture

- [x] Updated `.trellis/spec/backend/production-startup.md` with the Windows
  PowerShell source contract and test requirements.
- [x] Added a byte-level regression check to `scripts/windows-scripts-smoke.ps1`.
- [x] Searched all tracked deployment PowerShell sources and removed the two
  non-ASCII literals found.
