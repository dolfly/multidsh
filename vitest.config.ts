import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Protocol integration tests run through pnpm test:contract.
    exclude: ['**/node_modules/**', 'tests/contract/**'],
    environment: 'node',
    // 默认 5s 对带看门狗/并发时序的用例在高负载 CI（Windows runner）上偏紧，
    // 偶发擦边超时。放宽到 15s：正常用例到达目标后立即返回，不受影响。
    testTimeout: 15_000
  }
})
