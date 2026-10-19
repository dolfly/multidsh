import { describe, expect, it } from 'vitest'
import { buildCreateInput } from './build-input'
import { EMPTY_FORM } from './types'

describe('buildCreateInput', () => {
  it('local:只带非默认字段', () => {
    const input = buildCreateInput({
      transport: 'local',
      form: { ...EMPTY_FORM, name: '本机', version: '0.1.6', port: '3080' },
      name: '本机',
      useExistingExternal: false,
      externalWorkspace: null,
      existingSpaceId: null
    })
    expect(input).toEqual({ transport: 'local', name: '本机', dshVersion: '0.1.6', port: 3080 })
  })

  it('local:默认启动器/空间/版本都省略', () => {
    const input = buildCreateInput({
      transport: 'local',
      form: { ...EMPTY_FORM, name: 'a' },
      name: 'a',
      useExistingExternal: false,
      externalWorkspace: null,
      existingSpaceId: null
    })
    expect(input).toEqual({ transport: 'local', name: 'a' })
  })

  it('local:接管外部 dsh 时带 pid 与 access', () => {
    const input = buildCreateInput({
      transport: 'local',
      form: { ...EMPTY_FORM, name: 'a', externalAccess: ' tok ' },
      name: 'a',
      useExistingExternal: true,
      externalWorkspace: { pid: 42, port: 3080, patch: null },
      existingSpaceId: null
    })
    expect(input).toMatchObject({
      transport: 'local',
      useExistingExternal: true,
      externalPid: 42,
      externalAccess: 'tok'
    })
  })

  it('ssh:非默认端口才带 port/remotePort', () => {
    expect(
      buildCreateInput({
        transport: 'ssh',
        form: { ...EMPTY_FORM, host: ' h ', username: ' u ', sshPort: '22', remotePort: '3080' },
        name: 'a',
        useExistingExternal: false,
        externalWorkspace: null,
        existingSpaceId: null
      })
    ).toEqual({ transport: 'ssh', name: 'a', host: 'h', username: 'u' })
    expect(
      buildCreateInput({
        transport: 'ssh',
        form: { ...EMPTY_FORM, host: 'h', username: 'u', sshPort: '2222', remotePort: '8080' },
        name: 'a',
        useExistingExternal: false,
        externalWorkspace: null,
        existingSpaceId: null
      })
    ).toEqual({
      transport: 'ssh',
      name: 'a',
      host: 'h',
      username: 'u',
      port: 2222,
      remotePort: 8080
    })
  })

  it('http:归一化 endpointUrl（去空白）', () => {
    expect(
      buildCreateInput({
        transport: 'http',
        form: { ...EMPTY_FORM, endpointUrl: ' https://gw ' },
        name: 'a',
        useExistingExternal: false,
        externalWorkspace: null,
        existingSpaceId: null
      })
    ).toEqual({ transport: 'http', name: 'a', endpointUrl: 'https://gw' })
  })
})
