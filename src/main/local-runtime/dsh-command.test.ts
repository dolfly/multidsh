import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { findDshWebArgs, patchOf, portOf } from './dsh-command'
import { DSH_BIN, DSH_PROFILE_CMD, DSH_WEB_CMD, HOME, PATCH } from './external-dsh.testkit'

/**
 *   node ~/.local/bin/dsh --profile web --patch ~/.dush/cordis.dush.patch.yml --no-open
 * hub 必须能发现它(只读探测:ps + lsof),且不能把自己的 spawn 或 shell 包装误报成外部实例。
 */
describe('findDshWebArgs(定位 dsh web 调用)', () => {
  it('入口 token:PATH 上的 dsh 与 dsh.js 是入口', () => {
    expect(findDshWebArgs('node /Users/me/.local/bin/dsh --profile web')).not.toBeNull()
    expect(findDshWebArgs('node /Users/me/.local/bin/dsh.js --profile web')).not.toBeNull()
  })

  it('入口 token:npm 全局包的 bin.js 是入口', () => {
    expect(
      findDshWebArgs(
        'node /opt/hub/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web'
      )
    ).not.toBeNull()
  })

  it('入口 token:目录名带 dsh 的其它程序不是入口', () => {
    // 以「token 结尾」判定而非「包含」:`dsh-hub-desktop/out/main/index.js` 不能当成入口
    expect(
      findDshWebArgs('node /Users/me/dsh-plugins/dsh-hub-desktop/out/main/index.js --profile web')
    ).toBeNull()
    expect(findDshWebArgs('node /Users/me/.local/bin/duush --profile web')).toBeNull()
    expect(findDshWebArgs('node /Users/me/.local/bin/dush --profile web')).toBeNull()
  })

  it('入口 token:Windows 反斜杠形态同样识别', () => {
    expect(findDshWebArgs('node C:\\Users\\me\\.local\\bin\\dsh --profile web')).not.toBeNull()
    expect(
      findDshWebArgs(
        'node C:\\opt\\hub\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web'
      )
    ).not.toBeNull()
  })

  it('识别当前形态:dsh --profile web', () => {
    expect(findDshWebArgs(DSH_PROFILE_CMD)).not.toBeNull()
  })

  it('识别旧形态:dsh web', () => {
    expect(findDshWebArgs(DSH_WEB_CMD)).not.toBeNull()
  })

  it('识别 --profile=web 等号写法', () => {
    expect(findDshWebArgs(`node ${DSH_BIN} --profile=web --no-open`)).not.toBeNull()
  })

  it('识别 dsh 发行版入口形态:@deepseek-ai/dsh/lib/bin.js', () => {
    expect(
      findDshWebArgs(
        'node /opt/hub/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 52300'
      )
    ).not.toBeNull()
  })

  it('dush/duush 包装器本身不当可接管对象(端口由它 spawn 的 dsh 持有)', () => {
    expect(
      findDshWebArgs(`node ${join(HOME, '.local/bin/dush')} --profile web --port 3080`)
    ).toBeNull()
    expect(
      findDshWebArgs(`node ${join(HOME, '.local/bin/duush')} --profile web --port 3080`)
    ).toBeNull()
  })

  it('排除插件管理命令(Hub 自己执行插件命令也走这个形态)', () => {
    expect(findDshWebArgs(`node ${DSH_BIN} plugin --profile web list`)).toBeNull()
    expect(
      findDshWebArgs(
        'node /opt/hub/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add foo'
      )
    ).toBeNull()
  })

  it('排除非 web profile', () => {
    expect(findDshWebArgs(`node ${DSH_BIN} --profile tui`)).toBeNull()
    expect(findDshWebArgs(`node ${DSH_BIN} --profile desktop`)).toBeNull()
  })

  it('排除 shell/grep 包装(它们把 dsh web 当参数)', () => {
    expect(findDshWebArgs('grep dsh web')).toBeNull()
    expect(findDshWebArgs('bash -c ps -axo pid=,command= | grep "dsh web"')).toBeNull()
    expect(findDshWebArgs('/bin/zsh -lc command -v dsh; dsh --version')).toBeNull()
    expect(findDshWebArgs('/usr/bin/pgrep -f /x/dsh web')).toBeNull()
  })

  it('patch 路径里含 "grep" 不影响识别(按词判定,不是子串)', () => {
    expect(findDshWebArgs('node /x/dsh --profile web --patch /tmp/my-grep.yml')).not.toBeNull()
  })

  it('patch 路径的 basename 恰是 grep/pgrep 也不影响识别', () => {
    // 取值在 dsh 入口之后,不是命令位置 —— 不能把真的 dsh 误判成 grep 包装行
    expect(findDshWebArgs('node /x/dsh --profile web --patch /home/u/grep')).not.toBeNull()
    expect(findDshWebArgs('node /x/dsh --profile web --patch /usr/local/bin/pgrep')).not.toBeNull()
  })

  it('裸名 dsh 只有紧跟在 node 之后才算入口', () => {
    // node dsh → dsh 是入口
    expect(findDshWebArgs('node dsh --profile web --port 3080')).not.toBeNull()
    expect(findDshWebArgs('node dsh.js --profile web --port 3080')).not.toBeNull()
    // npm run dsh → dsh 是脚本名,不是入口
    expect(findDshWebArgs('npm run dsh -- --profile web')).toBeNull()
    expect(findDshWebArgs('npm exec dsh -- --profile web')).toBeNull()
  })

  it('排除无关进程与「目录名里带 dsh」的干扰项', () => {
    expect(findDshWebArgs('/usr/sbin/cupsd')).toBeNull()
    expect(
      findDshWebArgs(`node ${join(HOME, 'dsh-plugins/dsh-hub-desktop/out/main/index.js')}`)
    ).toBeNull()
    expect(findDshWebArgs(`node ${DSH_BIN} --version`)).toBeNull()
  })

  it('识别 Windows 路径形态', () => {
    expect(findDshWebArgs('node C:\\Users\\me\\.local\\bin\\dsh web --no-open')).not.toBeNull()
    expect(
      findDshWebArgs('node C:\\Users\\me\\.local\\bin\\dsh --profile web --no-open')
    ).not.toBeNull()
    expect(findDshWebArgs('C:\\Windows\\system32\\cmd.exe /c dsh --version')).toBeNull()
  })

  it('返回 dsh 入口之后的参数', () => {
    expect(findDshWebArgs(DSH_PROFILE_CMD)).toEqual([
      '--patch',
      PATCH,
      '--profile',
      'web',
      '--port',
      '3080',
      '--no-open'
    ])
  })

  it('不是 dsh web 调用时返回 null', () => {
    expect(findDshWebArgs(`node ${DSH_BIN} --version`)).toBeNull()
    expect(findDshWebArgs('grep dsh web')).toBeNull()
  })
})

describe('patchOf / portOf(参数解析)', () => {
  it('空格与等号两种写法都能取到 --patch', () => {
    expect(patchOf('dsh web --patch /a/b.yml')).toBe('/a/b.yml')
    expect(patchOf('dsh web --patch=/a/b.yml')).toBe('/a/b.yml')
    expect(patchOf('dsh web --no-open')).toBeNull()
  })

  it('-port 取合法端口,非法值返回 null(留给 lsof 兜底)', () => {
    expect(portOf('dsh web --port 52300')).toBe(52300)
    expect(portOf('dsh web --port=3080')).toBe(3080)
    expect(portOf('dsh web --port 99999')).toBeNull()
    expect(portOf('dsh web --no-open')).toBeNull()
  })
})
