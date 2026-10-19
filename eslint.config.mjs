import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out',
      'dist',
      'node_modules',
      'coverage',
      'hub-data',
      'build/npm-runtime',
      'build/pnpm-runtime'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node 脚本(验收/渲染,CommonJS 或 ESM):显式声明 node 全局,允许 require
    files: ['scripts/**/*.cjs', 'scripts/**/*.mjs', 'design/banner/**/*.mjs', 'hub-data/**/*.cjs'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        // hub.evaluate() 内的代码在渲染进程上下文执行(Playwright 注入)
        window: 'readonly',
        document: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  // ── 架构分层护栏（AGENTS「接口与安全」规则 2）──
  // 同一文件只保留一条 no-restricted-imports 入口：flat config 对同名规则是覆盖而非合并，
  // 拆成多条会让后写的规则顶掉先前的禁令。子路径导入（electron/* 等）用 patterns 承载。
  //
  // shared：被主进程与渲染层共享，不得 import Electron，也不得反向依赖 main/renderer。
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '框架无关层不得 import Electron（AGENTS 规则 2）；需要宿主能力时由调用方注入。'
            }
          ],
          patterns: [
            {
              group: ['electron/*'],
              message:
                '框架无关层不得 import Electron（AGENTS 规则 2）；需要宿主能力时由调用方注入。'
            },
            {
              group: ['../main/*', '../*/main/*', '../renderer/*', '../*/renderer/*'],
              message: 'shared 被主进程与渲染层共享，不得反向 import 任一侧。'
            }
          ]
        }
      ]
    }
  },
  // 主进程整体不渲染 UI：import react 说明组件放错了层（须先于敏感目录条目声明，
  // 由后者的合并规则覆盖，避免同名规则互相顶掉）。
  {
    files: ['src/main/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: '主进程不渲染 UI，组件应在 src/renderer。' },
            { name: 'react-dom', message: '主进程不渲染 UI，组件应在 src/renderer。' }
          ],
          patterns: [
            {
              group: ['react/*', 'react-dom/*'],
              message: '主进程不渲染 UI，组件应在 src/renderer。'
            }
          ]
        }
      ]
    }
  },
  // registry / transport / auth / vault / audit：框架无关层，不得 import Electron；
  // 也不渲染 UI，import react 说明组件放错了层。
  {
    files: [
      'src/main/registry/**/*.ts',
      'src/main/transport/**/*.ts',
      'src/main/auth/**/*.ts',
      'src/main/vault/**/*.ts',
      'src/main/audit/**/*.ts'
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '框架无关层不得 import Electron（AGENTS 规则 2）；需要宿主能力时由调用方注入。'
            },
            { name: 'react', message: '主进程不渲染 UI，组件应在 src/renderer。' },
            { name: 'react-dom', message: '主进程不渲染 UI，组件应在 src/renderer。' }
          ],
          patterns: [
            {
              group: ['electron/*'],
              message:
                '框架无关层不得 import Electron（AGENTS 规则 2）；需要宿主能力时由调用方注入。'
            },
            {
              group: ['react/*', 'react-dom/*'],
              message: '主进程不渲染 UI，组件应在 src/renderer。'
            }
          ]
        }
      ]
    }
  },
  // 渲染层：只能经 contextBridge（window.dshHub）访问宿主能力，不得直接 import node:*。
  // 测试在 Node 环境运行（vitest），豁免；react-hooks 规则在上方独立条目，互不覆盖。
  // testkit 是测试专用的支撑模块（不被生产入口引用、不进产物），同样在 Node 环境运行。
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/*.testkit.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: '渲染层不得直接 import node 模块；宿主能力经 window.dshHub 白名单桥接。'
            }
          ]
        }
      ]
    }
  },
  prettier
)
