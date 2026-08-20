# OPS-01 实施清单

- [x] `services.py`：支持 `PLATFORM_SECRET_KEY_FILE`（缺失 `PLATFORM_SECRET_KEY`
      时从受限文件读取）。
- [x] `deployment/AutoFlow.xml`：改用 `PLATFORM_SECRET_KEY_FILE`。
- [x] `scripts/install.ps1`：把密钥写入 `runtime\platform-secret.key` 并收紧 ACL，
      不再内联进 WinSW XML。
- [x] `docs/密钥托管与恢复.md`：密钥保存/读取优先级/丢失恢复。
- [x] 新增 `test_secret_custody.py`。

## 验证

- `test_secret_custody.py` 1 项通过。
- Windows 服务账户/ACL 的运行时行为需真实 Windows 主机验证，未伪造。
