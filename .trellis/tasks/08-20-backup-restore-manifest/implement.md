# BKP-02 实施清单

- [x] `crypto.py`：新增 `encrypt_bytes`/`decrypt_bytes`（AES-256-GCM 字节级）。
- [x] `backup.py`：`write_manifest`/`verify_manifest`（SHA-256 + 大小校验）、
      `encrypt_directory`/`decrypt_directory`。
- [x] `scripts/backup-manifest.py`：独立 CLI（write/verify），供 PowerShell 调用。
- [x] `backup.ps1` 备份后写清单；`restore.ps1` 恢复前校验清单。
- [x] 新增 `test_backup.py`（清单校验/篡改检测/加密目录往返）。

## 验证

- `test_backup.py` 3 项、`test_crypto.py` 4 项通过。
- 独立 CLI write/verify 手工验证通过（篡改返回 mismatch）。

## 未完成（需真实环境）

- 离线异地拷贝调度、失败告警、定时恢复 RPO/RTO 证据需 Windows/运维环境验证，未伪造。
