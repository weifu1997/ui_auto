# 代码审查技术方案

## Architecture

审查按四个独立边界组织：

1. **前端**：`src/` 的路由、页面组件、hooks、store、API 边界和类型安全。
2. **后端**：`server-py/autoflow` 的路由入口、服务层、持久化、认证/RBAC、隔离与生命周期契约。
3. **脚本与部署**：`scripts/`、`deployment/`、环境样例、启动流程和平台配置。
4. **测试与质量门禁**：单元测试、Python 测试、E2E 配置、CI 配置与覆盖缺口。

## Data Flow

- 先读取 backend/frontend 规范索引，建立项目基线。
- 通过目录清单、关键入口文件和安全敏感模式（认证、路径拼接、命令执行、SQL、secret、跨工作区访问）定位高风险代码。
- 对每个候选发现回溯数据来源、权限边界、调用方和测试证据。
- 用 lint/build/unit/Python 测试区分确认问题与待验证风险。

## Review Contracts

- CRITICAL：可导致数据丢失、越权、秘密泄漏、命令执行或核心流程不可用的问题。
- WARNING：可能产生错误行为、状态不一致、回归风险或明显维护负担的问题。
- INFO：改进建议；不作为阻塞项。
- 每个非信息级发现必须包含 `file:line`、证据、影响和建议动作。

## Validation

- `npm run lint`
- `npm run build`
- `npm run test:unit`
- `npm run test:py`
- 仅当静态审查发现需要运行时复现的风险时，追加 E2E 或 Windows smoke。

## Trade-offs

- 全库审查采用风险导向分层抽样，而非逐行穷举，以在有限时间内优先覆盖安全边界、核心业务流和高复杂度模块。
- 不修改产品代码；报告只提供修复建议，避免审查与实现混在同一变更中。
