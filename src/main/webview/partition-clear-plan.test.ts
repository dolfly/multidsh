import { describe, expect, it } from 'vitest'
import type { InstanceRecord } from '@shared/contracts'
import { planPartitionClear } from './partition-clear-plan'

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'x',
  authMode: 'auto',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z'
}

const http = {
  ...base,
  transport: 'http',
  endpointUrl: 'https://gw.example.com/dsh'
} as unknown as InstanceRecord
const ssh = {
  ...base,
  transport: 'ssh',
  host: '10.0.0.9',
  port: 22,
  username: 'u',
  remotePort: 3080,
  localPort: 32222,
  identityFile: null
} as unknown as InstanceRecord
const local = {
  ...base,
  transport: 'local',
  dshVersion: null,
  port: null,
  profile: null,
  autoStart: false
} as unknown as InstanceRecord

describe('planPartitionClear（装配层:清理链路）', () => {
  it('http:用持久化端点(与隧道无关)', () => {
    expect(planPartitionClear(http, undefined)).toEqual({
      partition: `persist:inst-${http.id}`,
      origin: 'https://gw.example.com',
      basePath: '/dsh'
    })
  })

  it('ssh:隧道仍在时用实时端口', () => {
    expect(planPartitionClear(ssh, 40001)).toEqual({
      partition: `persist:inst-${ssh.id}`,
      origin: 'http://127.0.0.1:40001',
      basePath: '/'
    })
  })

  it('ssh:隧道已停(删除实例是先停后清)必须回落持久化的 localPort', () => {
    // 若删掉这个回落,删除实例时的清理会静默 no-op,留下仍然有效的网关会话
    expect(planPartitionClear(ssh, undefined)).toEqual({
      partition: `persist:inst-${ssh.id}`,
      origin: 'http://127.0.0.1:32222',
      basePath: '/'
    })
  })

  it('ssh:从未分配过端口(未启动过)时返回 null', () => {
    const neverStarted = { ...ssh, localPort: null } as unknown as InstanceRecord
    expect(planPartitionClear(neverStarted, undefined)).toBeNull()
  })

  it('local 实例不清理(走 BrowserAuth,无网关会话)', () => {
    expect(planPartitionClear(local, undefined)).toBeNull()
  })

  it('记录缺失返回 null', () => {
    expect(planPartitionClear(null, undefined)).toBeNull()
  })

  it('basePath 与注入侧一致(带路径实例)', () => {
    const withPath = {
      ...http,
      endpointUrl: 'https://gw.example.com/team/dsh'
    } as unknown as InstanceRecord
    expect(planPartitionClear(withPath, undefined)?.basePath).toBe('/team/dsh')
  })
})
