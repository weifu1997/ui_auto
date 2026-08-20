# HTTPS 与服务账户密钥运维（SEC/OPS）

## 背景

内网部署目前把监听绑定到 `0.0.0.0` 且通过 HTTP 暴露；Secure cookie 为可选开启。
`PLATFORM_SECRET_KEY` 明文写入 WinSW XML，缺少最小权限与密钥托管边界。

## 目标（受控试点范围）

- 服务仅监听 loopback，局域网访问经批准的 HTTPS 反向代理终止。
- Secure 会话 cookie 默认开启（本地 HTTP 调试显式关闭）。
- 当 `AUTOFLOW_REQUIRE_HTTPS=1` 时，拒绝非 HTTPS 请求；仅信任配置的
  `AUTOFLOW_TRUSTED_PROXY` 转发的 `X-Forwarded-Proto`。

## 非目标

- 不实现平台密钥轮换（属 Phase 2 SEC-02）。
- 不在本任务实现 Windows 服务账户/ACL 的运行时校验（需 Windows 主机验证）。
