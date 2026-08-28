# SEC/OPS 实施清单

- [x] `auth.py`：Secure cookie 默认开启，`AUTOFLOW_COOKIE_SECURE=0` 显式关闭。
- [x] `transport.py`：新增可信代理/HTTPS 判定纯函数（`effective_https`）。
- [x] `main.py`：新增 `SecureTransportMiddleware`，`AUTOFLOW_REQUIRE_HTTPS=1`
      时拒绝非 HTTPS 请求。
- [x] `deployment/AutoFlow.xml`：监听改为 `127.0.0.1`，启用 HTTPS 强制与 Secure。

## 验证

- 后端：`tests/unit/test_secure_transport.py`（8 项）与 `test_auth.py` cookie 用例。
