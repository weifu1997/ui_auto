# Implementation Plan: Frontend Bundle Optimization

## Order

1. 修改 `vite.config.ts`，使用 Rolldown `output.codeSplitting` 拆分 vendor chunk。
2. 运行 `npm run build`，检查 shared/vendor chunk 是否全部低于 500 kB。
3. 新增 `scripts/check-bundle-size.mjs` 与 `check:bundle` npm script。
4. 将 `check:bundle` 加入 `test:all`。
5. 运行 lint/build/unit/Python 与体积检查。

## Validation Commands

```bash
npm run build
npm run check:bundle
npm run lint
npm run test:unit
npm run test:py
```

## Review Gates

- 构建输出无 chunk size warning。
- `dist/assets/*.js` 均低于 500 kB。
- 路由懒加载和共享 chunk 拆包不破坏现有页面。
- hash 文件名保持稳定，依赖未变时 vendor chunk 不重新生成。

## Rollback Points

- `vite.config.ts` 分包配置可单独回滚。
- `scripts/check-bundle-size.mjs` 可单独移除。
