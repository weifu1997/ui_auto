# Implementation Plan: Automation Edit Capabilities

## Order

1. 服务端增加 `PUT` schedule 更新端点。
2. 服务端增加 `PUT` webhook 更新与 `POST rotate-secret` 端点。
3. 服务端增加 `PUT` notification channel 更新与 `POST test` 端点。
4. 在 `PlatformServices` 增加测试通知发送方法，复用 `_post_notification` 与 SSRF 校验。
5. `src/platform-api.ts` 增加对应 API 函数。
6. `AutomationsPage` 增加编辑、轮换和测试 UI。
7. 新增后端 API 测试和 Playwright 编辑/测试回归。

## Validation Commands

```bash
npm run lint
npm run build
npm run test:unit
npm run test:py
npx playwright test tests/automation-edit.spec.ts
npm run test:e2e
```

## Review Gates

- 已有 schedule/webhook/channel 可通过 UI 编辑并持久化。
- Webhook secret 轮换后新 secret 只显示一次。
- 通知测试调用现有 SSRF/加密配置，不落投递记录。
- 所有编辑产生审计事件，响应不泄露 URL/keyword/signing secret。

## Rollback Points

- 后端每个 detail route 可独立回滚。
- 前端编辑 Modal 与 API 调用可独立移除。
