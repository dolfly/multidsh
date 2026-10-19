import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hmrDisabledInPatchText, userLayerDisablesHmr } from './profile-hmr'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'profile-hmr-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('hmrDisabledInPatchText', () => {
  it('列表项形式：字面量 disabled: true / false 都能判定', () => {
    expect(hmrDisabledInPatchText('- id: hmr\n  disabled: true\n')).toBe(true)
    expect(hmrDisabledInPatchText('- id: hmr\n  disabled: false\n')).toBe(false)
  })

  it('映射键形式（更深的子键）同样识别', () => {
    const text = [
      'entries:',
      '  - id: other',
      '  - id: hmr',
      '    name: x',
      '    disabled: true'
    ].join('\n')
    expect(hmrDisabledInPatchText(text)).toBe(true)
  })

  it('没有 hmr 行 / 只有别的行 id → 未判定', () => {
    expect(hmrDisabledInPatchText('- id: other\n  disabled: true\n')).toBeUndefined()
    expect(hmrDisabledInPatchText('')).toBeUndefined()
  })

  it('!!js 表达式无法判定 → 不判定（不误判 base 的 profileContext 表达式）', () => {
    expect(
      hmrDisabledInPatchText('- id: hmr\n  disabled: !!js "!ctx.get(\'profileContext\')"\n')
    ).toBeUndefined()
  })

  it('hmr 行没有 disabled 字段 → 未判定', () => {
    expect(
      hmrDisabledInPatchText('- id: hmr\n  name: "@deepseek-ai/dsh-hmr"\n  config:\n    root: []\n')
    ).toBeUndefined()
  })

  it('同一文件多次声明取最后一次（后者覆盖前者）', () => {
    const text = ['- id: hmr', '  disabled: true', '- id: hmr', '  disabled: false'].join('\n')
    expect(hmrDisabledInPatchText(text)).toBe(false)
    const reversed = ['- id: hmr', '  disabled: false', '- id: hmr', '  disabled: true'].join('\n')
    expect(hmrDisabledInPatchText(reversed)).toBe(true)
  })

  it('相邻条目的 disabled 不会串到 hmr 上', () => {
    const text = ['- id: hmr', '  name: x', '- id: other', '  disabled: true'].join('\n')
    expect(hmrDisabledInPatchText(text)).toBeUndefined()
  })

  it('注释与空行不影响判定', () => {
    const text = ['# 说明', '- id: hmr', '  # 注释', '', '  disabled: true # 关掉热重载'].join('\n')
    expect(hmrDisabledInPatchText(text)).toBe(true)
  })
})

describe('userLayerDisablesHmr', () => {
  it('profile 层声明 true → 判定关闭', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n', 'utf8')
    expect(await userLayerDisablesHmr(dir, join(dir, 'home'))).toBe(true)
  })

  it('home 层覆盖 profile 层（与 dsh 层叠顺序一致）', async () => {
    const dir = await tempDir()
    const home = join(dir, 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(dir, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n', 'utf8')
    await writeFile(join(home, 'cordis.patch.yml'), '- id: hmr\n  disabled: false\n', 'utf8')
    expect(await userLayerDisablesHmr(dir, home)).toBe(false)
  })

  it('文件缺失 / 无可判定声明 → false（交回启发式）', async () => {
    const dir = await tempDir()
    expect(await userLayerDisablesHmr(dir, join(dir, 'home'))).toBe(false)
    await writeFile(join(dir, 'cordis.patch.yml'), '- id: hmr\n  disabled: !!js expr\n', 'utf8')
    expect(await userLayerDisablesHmr(dir, join(dir, 'home'))).toBe(false)
  })
})
