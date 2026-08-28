# SEC/OPS Evidence

## Implementation

- `server-py/autoflow/auth.py`：Secure cookie 默认开启。
- `server-py/autoflow/transport.py`：可信代理/HTTPS 判定。
- `server-py/autoflow/main.py`：`SecureTransportMiddleware` 强制 HTTPS。
- `deployment/AutoFlow.xml`：loopback 绑定 + HTTPS/Secure 环境变量。

## Verification

Passed:

```text
test_secure_transport.py                             8 passed
test_auth.py (cookie cases)                         2 passed
```

## Known Limitations

- Windows 服务账户/ACL 与密钥托管需在 Windows 主机做真实验证，本任务未伪造该证据。
- 尚未推送远端、未创建 PR、未取得 CI 证据。
