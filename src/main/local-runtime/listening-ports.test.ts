import { describe, expect, it } from 'vitest'
import { parseListeningPorts, parseWindowsListeningPorts } from './listening-ports'
import { USER } from './external-dsh.testkit'

describe('parseListeningPorts(lsof 解析)', () => {
  it('pid → 首个监听端口', () => {
    const output = [
      'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      `node-darw  4323 ${USER}   38u  IPv4 0x1      0t0  TCP 127.0.0.1:49152 (LISTEN)`,
      `node      84758 ${USER}   21u  IPv4 0x2      0t0  TCP *:3080 (LISTEN)`,
      `node      84758 ${USER}   22u  IPv6 0x3      0t0  TCP *:3081 (LISTEN)`,
      `node      84758 ${USER}   23u  IPv4 0x4      0t0  TCP 127.0.0.1:3080 (ESTABLISHED)`
    ].join('\n')
    const ports = parseListeningPorts(output)
    expect(ports.get(84758)).toBe(3080) // 首个 LISTEN;ESTABLISHED 不算
    expect(ports.get(4323)).toBe(49152)
  })

  it('同一 pid 多条监听:优先回环绑定端口（不取 lsof 先输出的非回环端口）', () => {
    const output = [
      // 非回环端口先出现，回环端口后出现：接管连 127.0.0.1，应选回环那个
      `node 555 ${USER} 20u IPv4 0x1 0t0 TCP *:8080 (LISTEN)`,
      `node 555 ${USER} 21u IPv4 0x2 0t0 TCP 127.0.0.1:3080 (LISTEN)`
    ].join('\n')
    expect(parseListeningPorts(output).get(555)).toBe(3080)
  })
})

describe('parseWindowsListeningPorts(netstat 解析)', () => {
  it('pid → 首个 TCP LISTENING 端口,IPv6/UDP/其他状态被过滤', () => {
    const output = [
      '',
      '活动连接',
      '',
      '  协议  本地地址          外部地址        状态           PID',
      '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       84758',
      '  TCP    [::]:3080              [::]:0                 LISTENING       84758',
      '  TCP    127.0.0.1:49152        127.0.0.1:52300        ESTABLISHED     4323',
      '  UDP    0.0.0.0:5353           *:*                                    900',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234'
    ].join('\n')
    const ports = parseWindowsListeningPorts(output)
    expect(ports.get(84758)).toBe(3080) // 首个 LISTENING;ESTABLISHED 不算
    expect(ports.get(1234)).toBe(135)
    expect(ports.get(4323)).toBeUndefined()
    expect(ports.get(900)).toBeUndefined() // UDP 无状态列
  })

  it('同一 pid 多条监听:优先回环绑定端口', () => {
    const output = [
      '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       555',
      '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       555'
    ].join('\n')
    expect(parseWindowsListeningPorts(output).get(555)).toBe(3080)
  })
})
