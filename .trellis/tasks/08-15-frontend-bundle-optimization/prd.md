# 前端包体优化

## Goal

降低入口共享 chunk 体积，建立可执行的体积预算，消除 Vite 500 kB 警告，同时保持缓存命中与交互稳定性。

## Background

- 构建产物 `shared-*.js` 为 732.18 kB（gzip 236.84 kB），超过 Vite 500 kB 警戒线。
- 这是可测量的性能债务，不是当前数据完整性阻断项。

## Requirements

- R6.1 拆分治理表格、编辑器和 Ant Design 重依赖，避免所有页面共享 chunk 持续增长。
- R6.2 为入口共享 chunk 设定预算并在 CI 记录变化。
- R6.3 以消除 Vite 500 kB 警告为目标，不牺牲缓存命中或交互稳定性。

## Acceptance Criteria

- [x] `npm run build` 不再出现入口 shared chunk 超过 500 kB 警告。
- [x] 体积预算有 `scripts/check-bundle-size.mjs` 并接入 `test:all`。
- [x] 构建、lint、单元测试和 Python 单测保持通过。
- [x] 路由懒加载和共享 chunk 拆分不引入运行时加载回归。

## Notes

- 不进行新一轮视觉改版或删除功能。
- 不无度按页面全部独立分包，破坏缓存命中。
