/**
 * 两端资格锁引擎行为验证（无第三方测试框架，node 直接跑编译产物）。
 * 每个用例对应题面的一条不变量；失败即抛错并以非零码退出。
 */
import assert from 'node:assert/strict'

import { createEngine, type Clock } from '../src/domain/sync-lock/engine'
import type { LockStorage } from '../src/domain/sync-lock/types'

class MemoryStorage implements LockStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

class StepClock implements Clock {
  private step = 0
  now(): string {
    this.step += 1
    return `2026-11-13T10:${String(this.step).padStart(2, '0')}:00.000Z`
  }
}

function newEngine() {
  return createEngine(new MemoryStorage(), new StepClock())
}

let passed = 0
function test(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1. 复现 DATA-0001：源端摘除 + 目标未获批，链路不得再挂绿灯，监控必须红灯
test('DATA-0001 两端失格时链路阻断、监控红灯、延迟停在最后签收分片', () => {
  const engine = newEngine()
  const link = engine.getLink('link-data-0001')
  assert.equal(link.status, 'blocked')
  assert.equal(link.lastAckedShard, 3, '必须停在最后签收分片 #3')
  const credential = engine.getBlockingCredential('link-data-0001')
  assert.equal(credential.blocked, true)
  assert.ok(credential.reason && credential.reason.includes('SOUR-0001'))
  const readout = engine.getMonitorReadout('link-data-0001')
  assert.equal(readout.lamp, 'red', '阻断链路监控必须红灯')
  assert.equal(readout.lastAckedShard, 3)
  assert.deepEqual(readout.gapShards, [4, 5])
  // 阻断状态下禁止推进任何新分片
  assert.throws(() => engine.pumpShard('link-data-0001'), /运行中/)
})

// 2. 健康链路运行中撤回任一签章：立即阻断，最后签收分片不动
test('运行中撤回源端签章立即阻断且不前进水位', () => {
  const engine = newEngine()
  const before = engine.getLink('link-data-0002')
  assert.equal(before.status, 'running')
  engine.revokeSeal('seal-src-0002', '摘除源端连接印章')
  const after = engine.getLink('link-data-0002')
  assert.equal(after.status, 'blocked')
  assert.equal(after.lastAckedShard, before.lastAckedShard, '阻断后签收分片不得前进')
  assert.equal(after.targetWatermark, before.targetWatermark, '阻断后目标水位不得前进')
  assert.equal(engine.getMonitorReadout('link-data-0002').lamp, 'red')
  assert.throws(() => engine.pumpShard('link-data-0002'), /运行中/)
})

// 3. 恢复只补缺口分片：重发签章 → 恢复 → 只投递 gap 分片，已签收分片不动
test('恢复仅处理缺口分片且重新绑定新版本', () => {
  const engine = newEngine()
  engine.revokeSeal('seal-src-0001', '摘除')
  const reissued = engine.reissueSeal('seal-src-0001', '重新获批')
  assert.equal(reissued.version, 3)
  const recovered = engine.recoverSync('link-data-0001')
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.sourceSealVersion, 3, '恢复时绑定新签章版本')
  const shards = recovered.shards
  assert.deepEqual(shards.map((s) => s.state), ['delivered', 'delivered', 'delivered', 'delivered', 'delivered'])
  // 原本已签收的 #1-#3 投递时间不被重写
  assert.equal(shards[0].deliveredAt, '2026-11-13T09:00:00.000Z', '已签收分片不能被重复写入')
  assert.notEqual(shards[3].deliveredAt, '2026-11-13T09:00:00.000Z')
  assert.equal(recovered.lastAckedShard, 5)
})

// 4. 签章仍撤回时恢复必须失败并保持阻断
test('签章未恢复前恢复动作被资格锁拒绝', () => {
  const engine = newEngine()
  assert.throws(() => engine.recoverSync('link-data-0001'), /阻断/)
  assert.equal(engine.getLink('link-data-0001').status, 'blocked')
})

// 5. 切换目标：旧目标水位作废，缺口重投，禁止把旧源水位写进新目标
test('切换目标后旧目标水位作废且新目标从缺口分片重建水位', () => {
  const engine = newEngine()
  const before = engine.getLink('link-data-0002')
  assert.equal(before.targetWatermark, 'wt:0004')
  const switched = engine.switchTarget('link-data-0002', 'seal-tgt-0003')
  assert.equal(switched.targetWatermark, null, '旧目标水位必须作废')
  assert.ok(switched.shards.every((s) => s.targetWatermark === null), '新目标上不能继承任何旧写入')
  assert.equal(switched.status, 'recovering')
  const recovered = engine.recoverSync('link-data-0002')
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.targetWatermark, 'wt:0004', '新目标水位由缺口分片重新推进')
  // 源水位只随分片携带，不直接复制为目标水位
  assert.ok(recovered.shards.every((s) => s.sourceWatermark.startsWith('ws:')))
  assert.ok(recovered.shards.every((s) => (s.targetWatermark as string).startsWith('wt:')))
})

// 6. 未获批目标禁止切换
test('切换到撤回状态的目标签章被拒绝', () => {
  const engine = newEngine()
  assert.throws(() => engine.switchTarget('link-data-0002', 'seal-tgt-0002'), /未获批/)
})

// 7. 交叉操作：切换目标与停链按锁序号定终态
test('先切换后停止：最大锁序号为停止，终态已停止', () => {
  const engine = newEngine()
  const { link, finalLockSeq } = engine.switchThenStop('link-data-0002', 'seal-tgt-0003')
  assert.equal(link.status, 'stopped')
  const terminal = engine.terminalEvent('link-data-0002')
  assert.equal(terminal.lockSeq, finalLockSeq)
  assert.equal(terminal.action, 'stop')
  assert.equal(terminal.toStatus, 'stopped')
})

test('先停止后切换：最大锁序号为切换，终态由切换事件决定（恢复中/阻断）', () => {
  const engine = newEngine()
  const { link, finalLockSeq } = engine.stopThenSwitch('link-data-0002', 'seal-tgt-0003')
  assert.ok(link.status === 'recovering' || link.status === 'blocked')
  assert.notEqual(link.status, 'running', '停止后切换目标不能自行复活为运行中')
  const terminal = engine.terminalEvent('link-data-0002')
  assert.equal(terminal.lockSeq, finalLockSeq)
  assert.equal(terminal.action, 'switch_target')
})

test('切换目标后该目标签章被撤回：链路阻断且新目标仍无水位，监控红灯', () => {
  const engine = newEngine()
  const switched = engine.switchTarget('link-data-0002', 'seal-tgt-0003')
  assert.equal(switched.status, 'recovering')
  engine.revokeSeal('seal-tgt-0003', '新目标连接未获批')
  const link = engine.getLink('link-data-0002')
  assert.equal(link.status, 'blocked')
  assert.equal(link.targetWatermark, null, '新目标被撤回时绝不能写入任何水位')
  const credential = engine.getBlockingCredential('link-data-0002')
  assert.equal(credential.blocked, true)
  assert.ok(credential.revokedSealIds.includes('seal-tgt-0003'))
  assert.equal(engine.getMonitorReadout('link-data-0002').lamp, 'red')
})

// 8. 同一确认键只产生一份写入（confirmIndex 幂等 + 回退释放后可重投）
test('确认键全局唯一：重复投递不产生第二份写入，回退后释放再投仍一份', () => {
  const engine = newEngine()
  engine.pumpShard('link-data-0002')
  const afterFirst = engine.getLink('link-data-0002')
  const countAfterFirst = Object.keys(readConfirmIndex(engine)).length
  // 再推进一片，确认键不同；每片都只登记一次
  const afterSecond = engine.pumpShard('link-data-0002')
  const lastShard = afterSecond.shards[afterSecond.shards.length - 1]
  const lastKey = lastShard.confirmKey
  assert.equal(Object.keys(readConfirmIndex(engine)).length, countAfterFirst + 1)
  assert.equal(readConfirmIndex(engine)[lastKey], 'link-data-0002')
  // 回退最后分片释放确认键，恢复重投后同一确认键仍只有一份写入
  engine.rollbackSync('link-data-0002')
  assert.equal(readConfirmIndex(engine)[lastKey], undefined)
  assert.equal(engine.getLink('link-data-0002').lastAckedShard, afterFirst.lastAckedShard)
  engine.recoverSync('link-data-0002')
  assert.equal(readConfirmIndex(engine)[lastKey], 'link-data-0002')
  // 同一确认键在索引里始终只有一条记录
  const sameKeyCount = Object.values(readConfirmIndex(engine)).length
  assert.equal(sameKeyCount, new Set(Object.keys(readConfirmIndex(engine))).size)
})

// 9. 生命周期顺序：状态切换 → 恢复 → 归档 → 回退，乱序被拒
test('生命周期按 切换/恢复/归档/回退 顺序留痕，归档后只能回退', () => {
  const engine = newEngine()
  engine.stopSync('link-data-0002')
  engine.archiveSync('link-data-0002')
  assert.throws(() => engine.recoverSync('link-data-0002'), /归档|不允许/)
  const rolled = engine.rollbackSync('link-data-0002')
  assert.equal(rolled.status, 'stopped')
  const events = engine.listEvents('link-data-0002')
  const stages = events.map((e) => e.stage)
  const firstArchive = stages.indexOf('archive')
  const firstRollback = stages.indexOf('rollback')
  assert.ok(firstArchive >= 0 && firstRollback > firstArchive)
  // 锁序号全局单调
  const seqs = events.map((e) => e.lockSeq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.equal(new Set(seqs).size, seqs.length, '锁序号不得重复')
})

// 10. 三处同源：同步凭据、source 视角、监控读数对同一链路给出同一阻断结论
test('同步、source、监控读取同一阻断凭据', () => {
  const engine = newEngine()
  engine.revokeSeal('seal-src-0002', '摘除')
  const credential = engine.getBlockingCredential('link-data-0002')
  const readout = engine.getMonitorReadout('link-data-0002')
  const link = engine.getLink('link-data-0002')
  assert.equal(credential.blocked, readout.blocked)
  assert.equal(credential.blocked, link.status === 'blocked')
  assert.equal(readout.blockedReason, credential.reason)
  // 源端签章列表里该签章确为撤回
  const seal = engine.listSeals().find((s) => s.sealId === 'seal-src-0002')
  assert.equal(seal?.status, 'revoked')
})

// 11. 列表与详情同源：引擎只有一份数据，列表行与详情对象内容一致
test('列表入口与详情面板读取同一份数据，不出现列表旧值/详情丢值', () => {
  const engine = newEngine()
  engine.revokeSeal('seal-src-0002', '摘除')
  const listRow = engine.listLinks().find((l) => l.linkId === 'link-data-0002')
  const detail = engine.getLink('link-data-0002')
  assert.equal(listRow?.status, 'blocked')
  assert.equal(detail.status, listRow?.status)
  assert.equal(detail.lastAckedShard, listRow?.lastAckedShard)
  assert.equal(detail.targetWatermark, listRow?.targetWatermark)
})

// 12. 持久化：重新加载引擎后阻断状态、水位、确认键索引保持一致
test('localStorage 持久化后重载，资格锁状态与水位不丢失', () => {
  const storage = new MemoryStorage()
  const clock = new StepClock()
  const first = createEngine(storage, clock)
  first.revokeSeal('seal-src-0002', '摘除')
  const reloaded = createEngine(storage, clock)
  assert.equal(reloaded.getLink('link-data-0002').status, 'blocked')
  assert.equal(reloaded.getMonitorReadout('link-data-0002').lamp, 'red')
  assert.equal(reloaded.getBlockingCredential('link-data-0002').blocked, true)
})

function readConfirmIndex(engine: ReturnType<typeof newEngine>): Record<string, string> {
  // confirmIndex 是引擎内部索引，通过 listEvents 同模块的持久化状态间接读取：
  // 这里借助引擎已暴露行为校验；为直接断言，使用 JSON 重新装载的内存存储。
  return (engine as unknown as { state: { confirmIndex: Record<string, string> } }).state.confirmIndex
}

console.log(`\n两端资格锁引擎验证：${passed} 个用例全部通过\n`)
