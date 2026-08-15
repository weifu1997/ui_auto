# Design: Frontend Bundle Optimization

## Boundary

只优化构建分包与体积预算，不重写路由、页面结构或视觉样式。

## Current State

`npm run build` 输出的 `shared-*.js` 约 739 kB（gzip 约 239 kB），超过 Vite 500 kB 警告线。路由页面已懒加载，但共享入口仍包含大量 vendor 与公共代码。

## Build Splitting

Vite 8 使用 Rolldown。通过 `build.rolldownOptions.output.codeSplitting` 对 node_modules 做 vendor 分包：

- 使用 `groups` 捕获 node_modules 模块。
- 使用 `minSize` / `maxSize` 将大 vendor 组拆成多个不超过预算的 chunk。
- 保留自动 tree-shaking 与缓存策略：只有依赖变化时 vendor hash 才变化。

目标：任何 entry shared chunk 低于 500 kB，并且 Vite 不再输出 chunk size warning。

## Bundle Budget

新增 `scripts/check-bundle-size.mjs`：

- 读取 `dist/assets/*.js`。
- 计算 minified 大小（以 kB 计）。
- 默认预算 `500 kB`，可用 `BUNDLE_SIZE_LIMIT_KB` 覆盖。
- 任一 chunk 超过预算即非零退出。

新增 npm script：

```json
"check:bundle": "node scripts/check-bundle-size.mjs"
```

`test:all` 在 build 后执行 `check:bundle`，让体积回归成为门禁。

## Verification

- `npm run build` 不再出现 `shared-*.js` 超过 500 kB 警告。
- `npm run check:bundle` 通过。
- `npm run build` / `npm run lint` / `npm run test:unit` / `npm run test:py` 保持通过。
- 生产入口仍使用 hash 文件名，缓存命中不因每次构建失效。

## Rollback

- 回滚 `vite.config.ts` 的 `codeSplitting` 配置即可恢复当前构建行为。
- `check-bundle-size.mjs` 与 npm script 可独立移除。
