import {
  LIFECYCLE_ORDER,
  type BlockingCredential,
  type EndpointRole,
  type EndpointSeal,
  type EventAction,
  type LifecycleEvent,
  type LifecycleStage,
  type LockStorage,
  type MonitorReadout,
  type Shard,
  type SyncLink,
  type SyncLockStore,
  type SyncStatus,
} from './types'

/**
 * 两端资格锁引擎。
 * 不变量：
 * 1. 运行计划同时绑定源端、目标端当前签章（id+version），任一撤回即阻断，停在最后签收分片；
 * 2. 恢复只处理缺口分片，目标切换后旧目标水位作废，绝不把旧源水位写进新目标；
 * 3. 所有变更入口统一领取全局锁序号 lockSeq，交叉操作终态按最大锁序号定；
 * 4. 同一 confirmKey 在 confirmIndex 里只登记一次，不产生两份写入；
 * 5. 同步、source、监控读取同一份阻断凭据。
 */

export const LOCK_STORAGE_KEY = 'data-layer-studio:sync-lock:v1'

export interface Clock {
  now(): string
}

const ISO_CLOCK: Clock = { now: () => new Date().toISOString() }

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

function resolveStorage(storage?: LockStorage): LockStorage {
  if (storage) return storage
  if (typeof globalThis !== 'undefined' && (globalThis as unknown as { localStorage?: LockStorage }).localStorage) {
    return (globalThis as unknown as { localStorage: LockStorage }).localStorage
  }
  return new MemoryStorage()
}

function emptyStore(): SyncLockStore {
  return {
    version: 1,
    lockSeq: 0,
    seals: {},
    links: {},
    events: [],
    confirmIndex: {},
    seeded: false,
  }
}

export interface Eligibility {
  eligible: boolean
  reason: string | null
  revokedSealIds: string[]
}

export class SyncLockEngine {
  private state: SyncLockStore
  private storage: LockStorage
  private clock: Clock

  constructor(storage?: LockStorage, clock?: Clock) {
    this.storage = resolveStorage(storage)
    this.clock = clock ?? ISO_CLOCK
    this.state = this.load()
    if (!this.state.seeded) {
      this.seed()
    }
  }

  // ---------- 持久化 ----------

  private load(): SyncLockStore {
    const raw = this.storage.getItem(LOCK_STORAGE_KEY)
    if (!raw) return emptyStore()
    try {
      const parsed = JSON.parse(raw) as SyncLockStore
      return { ...emptyStore(), ...parsed }
    } catch {
      return emptyStore()
    }
  }

  private persist(): void {
    this.storage.setItem(LOCK_STORAGE_KEY, JSON.stringify(this.state))
  }

  private nextLockSeq(): number {
    this.state.lockSeq += 1
    return this.state.lockSeq
  }

  private now(): string {
    return this.clock.now()
  }

  // ---------- 生命周期留痕：状态切换 → 恢复 → 归档 → 回退 按序 ----------

  private record(
    link: SyncLink,
    stage: LifecycleStage,
    action: EventAction,
    fromStatus: SyncStatus,
    toStatus: SyncStatus,
    detail: string,
  ): LifecycleEvent {
    this.assertLifecycleOrder(link, stage, fromStatus, toStatus)
    const event: LifecycleEvent = {
      lockSeq: this.nextLockSeq(),
      linkId: link.linkId,
      stage,
      action,
      fromStatus,
      toStatus,
      detail,
      at: this.now(),
    }
    this.state.events.push(event)
    return event
  }

  /**
   * 生命周期顺序约束：
   * - 同一链路事件的阶段只能沿 切换→恢复→归档→回退 推进；
   * - 回退（rollback）是终态动作，回退后该链路不再接受归档；
   * - 状态切换/恢复可以在未归档前交替，但不能越过归档。
   */
  private assertLifecycleOrder(
    link: SyncLink,
    stage: LifecycleStage,
    fromStatus: SyncStatus,
    toStatus: SyncStatus,
  ): void {
    const history = this.state.events.filter((event) => event.linkId === link.linkId)
    if (history.length === 0) {
      if (stage !== 'switch') {
        throw new Error(`链路 ${link.linkCode} 生命周期非法：首个事件必须是状态切换，收到 ${stage}`)
      }
      return
    }
    // 归档回退（archived → stopped）是终态回退，之后只能重新走状态切换，不能再恢复/归档
    const archivedRollback = history.some(
      (event) => event.stage === 'rollback' && event.fromStatus === 'archived',
    )
    if (archivedRollback && stage !== 'switch') {
      throw new Error(`链路 ${link.linkCode} 已执行归档回退，只能重新走状态切换，不能再执行 ${stage}`)
    }
    const archived = history.some((event) => event.stage === 'archive')
    if (archived && stage !== 'rollback') {
      throw new Error(`链路 ${link.linkCode} 已归档，归档后只允许回退，不能再执行 ${stage}`)
    }
    // 阶段只能沿 切换 → 恢复 → 归档 → 回退 推进；
    // 分片级回退（rollback 且非归档回退）允许随后再恢复补齐，属于回退→恢复的补救闭环
    const maxStage = history
      .filter((event) => !(event.stage === 'rollback' && event.fromStatus !== 'archived'))
      .reduce((max, event) => Math.max(max, LIFECYCLE_ORDER.indexOf(event.stage)), 0)
    const idx = LIFECYCLE_ORDER.indexOf(stage)
    if (stage !== 'switch' && stage !== 'recover' && idx < maxStage) {
      throw new Error(`链路 ${link.linkCode} 生命周期乱序：${stage} 不能晚于阶段序号 ${maxStage}`)
    }
    if (fromStatus !== toStatus && !this.isLegalTransition(fromStatus, toStatus, stage)) {
      throw new Error(`链路 ${link.linkCode} 状态流转非法：${fromStatus} → ${toStatus}（${stage}）`)
    }
  }

  private isLegalTransition(from: SyncStatus, to: SyncStatus, stage: LifecycleStage): boolean {
    const table: Record<LifecycleStage, Array<[SyncStatus, SyncStatus]>> = {
      switch: [
        ['draft', 'running'],
        ['running', 'stopped'],
        ['running', 'blocked'],
        ['running', 'recovering'],
        ['recovering', 'blocked'],
        ['recovering', 'running'],
        ['recovering', 'recovering'],
        ['blocked', 'stopped'],
        ['blocked', 'recovering'],
        ['recovering', 'stopped'],
        ['stopped', 'blocked'],
        ['stopped', 'recovering'],
      ],      recover: [
        ['blocked', 'recovering'],
        ['recovering', 'running'],
        ['recovering', 'blocked'],
      ],
      archive: [
        ['stopped', 'archived'],
        ['blocked', 'archived'],
      ],
      rollback: [
        ['archived', 'stopped'],
        ['stopped', 'blocked'],
        ['blocked', 'recovering'],
        ['running', 'recovering'],
        ['recovering', 'recovering'],
      ],
    }
    return table[stage].some(([a, b]) => a === from && b === to)
  }

  // ---------- 签章 ----------

  listSeals(): EndpointSeal[] {
    return Object.values(this.state.seals).sort((a, b) => a.sealId.localeCompare(b.sealId))
  }

  getSeal(sealId: string): EndpointSeal {
    const seal = this.state.seals[sealId]
    if (!seal) throw new Error(`签章 ${sealId} 不存在`)
    return structuredCloneSafe(seal)
  }

  /** 撤回签章（摘除连接 / 换成未获批连接）：所有绑定它的链路立即按资格锁阻断。 */
  revokeSeal(sealId: string, reason: string): EndpointSeal {
    const seal = this.state.seals[sealId]
    if (!seal) throw new Error(`签章 ${sealId} 不存在`)
    if (seal.status === 'revoked') {
      return structuredCloneSafe(seal)
    }
    seal.status = 'revoked'
    seal.reason = reason
    seal.updatedAt = this.now()
    const affected = Object.values(this.state.links).filter(
      (link) =>
        (link.sourceSealId === sealId && link.sourceSealVersion === seal.version) ||
        (link.targetSealId === sealId && link.targetSealVersion === seal.version),
    )
    for (const link of affected) {
      this.reconcileLink(link, `签章 ${seal.endpointCode} 撤回：${reason}`)
    }
    this.persist()
    return structuredCloneSafe(seal)
  }

  /** 重新签发签章：版本号 +1，旧版本自动失效，链路需显式恢复并重新绑定新版本。 */
  reissueSeal(sealId: string, reason: string): EndpointSeal {
    const seal = this.state.seals[sealId]
    if (!seal) throw new Error(`签章 ${sealId} 不存在`)
    seal.version += 1
    seal.status = 'active'
    seal.reason = reason
    seal.updatedAt = this.now()
    const affected = Object.values(this.state.links).filter(
      (link) => link.sourceSealId === sealId || link.targetSealId === sealId,
    )
    for (const link of affected) {
      // 旧版本与新版本不一致，链路依旧处于无有效资格状态，需要恢复时重新绑定
      this.reconcileLink(link, `签章 ${seal.endpointCode} 换发新版本 v${seal.version}，旧版本失效`)
    }
    this.persist()
    return structuredCloneSafe(seal)
  }

  // ---------- 资格判定：同步、source、监控共用同一份凭据 ----------

  /** 评估链路当前两端签章是否仍具备运行资格。 */
  evaluateEligibility(link: SyncLink): Eligibility {
    const revoked: string[] = []
    const reasons: string[] = []
    this.collectSealFaults(link.sourceSealId, link.sourceSealVersion, '源端', reasons, revoked)
    this.collectSealFaults(link.targetSealId, link.targetSealVersion, '目标端', reasons, revoked)
    return {
      eligible: reasons.length === 0,
      reason: reasons.length ? reasons.join('；') : null,
      revokedSealIds: revoked,
    }
  }

  private collectSealFaults(
    sealId: string,
    boundVersion: number,
    roleLabel: string,
    reasons: string[],
    revoked: string[],
  ): void {
    const seal = this.state.seals[sealId]
    if (!seal) {
      reasons.push(`${roleLabel}签章缺失`)
      return
    }
    const code = `${roleLabel}连接 ${seal.endpointCode}`
    const faults: string[] = []
    if (seal.version !== boundVersion) {
      faults.push(`签章已换发（计划绑定 v${boundVersion}，当前 v${seal.version}）`)
    }
    if (seal.status !== 'active') {
      faults.push(`${code} 已摘除/撤回或未获批`)
      revoked.push(seal.sealId)
    }
    if (faults.length) {
      reasons.push(`${code}：${faults.join('，')}`)
    }
  }

  /** 阻断凭据：三处读同一个出口，杜绝监控侧仍报绿灯。 */
  getBlockingCredential(linkId: string): BlockingCredential {
    const link = this.requireLink(linkId)
    const eligibility = this.evaluateEligibility(link)
    return {
      linkId: link.linkId,
      linkCode: link.linkCode,
      blocked: !eligibility.eligible,
      reason: eligibility.reason,
      revokedSealIds: eligibility.revokedSealIds,
      sourceSealId: link.sourceSealId,
      targetSealId: link.targetSealId,
      lockSeq: this.state.lockSeq,
      at: this.now(),
    }
  }

  /** 监控读数：与阻断凭据同源，阻断即红灯，延迟读数不再冒充正常。 */
  getMonitorReadout(linkId: string): MonitorReadout {
    const link = this.requireLink(linkId)
    const credential = this.getBlockingCredential(linkId)
    const gapShards = link.shards
      .filter((shard) => shard.state === 'gap' || shard.state === 'rolledback')
      .map((shard) => shard.shardNo)
    const latestDelivered = [...link.shards]
      .filter((shard) => shard.state === 'delivered')
      .sort((a, b) => b.shardNo - a.shardNo)[0]
    const lamp: MonitorReadout['lamp'] = credential.blocked
      ? 'red'
      : link.status === 'recovering' || gapShards.length > 0
        ? 'amber'
        : 'green'
    return {
      linkId: link.linkId,
      linkCode: link.linkCode,
      linkStatus: link.status,
      blocked: credential.blocked,
      blockedReason: credential.reason,
      lastAckedShard: link.lastAckedShard,
      gapShards,
      targetWatermark: link.targetWatermark,
      sourceWatermark: latestDelivered ? latestDelivered.sourceWatermark : null,
      lamp,
      at: this.now(),
    }
  }

  // ---------- 链路查询 ----------

  listLinks(): SyncLink[] {
    return Object.values(this.state.links)
      .sort((a, b) => a.linkCode.localeCompare(b.linkCode))
      .map((link) => structuredCloneSafe(link))
  }

  getLink(linkId: string): SyncLink {
    return structuredCloneSafe(this.requireLink(linkId))
  }

  listEvents(linkId?: string): LifecycleEvent[] {
    const events = linkId
      ? this.state.events.filter((event) => event.linkId === linkId)
      : [...this.state.events]
    return events.map((event) => ({ ...event }))
  }

  private requireLink(linkId: string): SyncLink {
    const link = this.state.links[linkId]
    if (!link) throw new Error(`同步链路 ${linkId} 不存在`)
    return link
  }

  // ---------- 链路动作 ----------

  /** 启动同步：资格锁不通过直接拒绝，不允许挂着绿灯运行。 */
  startSync(linkId: string): SyncLink {
    const link = this.requireLink(linkId)
    const from = link.status
    if (from === 'running') return structuredCloneSafe(link)
    const eligibility = this.evaluateEligibility(link)
    if (!eligibility.eligible) {
      this.reconcileLink(link, eligibility.reason ?? '两端签章不具备运行资格')
      this.persist()
      throw new Error(`链路 ${link.linkCode} 启动被资格锁阻断：${eligibility.reason}`)
    }
    if (from !== 'draft' && from !== 'recovering') {
      throw new Error(`链路 ${link.linkCode} 当前状态「${from}」不允许启动`)
    }
    link.status = 'running'
    link.blockedReason = null
    link.updatedAt = this.now()
    this.record(link, 'switch', 'start', from, 'running', '两端签章均有效，启动同步')
    this.persist()
    return structuredCloneSafe(link)
  }

  /** 停止同步：停在最后签收分片。 */
  stopSync(linkId: string): SyncLink {
    const link = this.requireLink(linkId)
    const from = link.status
    if (from === 'stopped' || from === 'archived' || from === 'draft') {
      throw new Error(`链路 ${link.linkCode} 当前状态「${from}」不允许停止`)
    }
    link.status = 'stopped'
    link.blockedReason = null
    link.updatedAt = this.now()
    this.record(
      link,
      'switch',
      'stop',
      from,
      'stopped',
      `停止同步，停在最后签收分片 #${link.lastAckedShard}`,
    )
    this.persist()
    return structuredCloneSafe(link)
  }

  /**
   * 切换目标端：新目标必须持有有效签章。
   * 旧目标水位立即作废（targetWatermark=null），已投递分片在新目标上标记为缺口，
   * 恢复时逐片重投，绝不把旧源水位直接写进新目标。
   */
  switchTarget(linkId: string, newTargetSealId: string): SyncLink {
    const link = this.requireLink(linkId)
    const from = link.status
    if (from === 'archived') {
      throw new Error(`链路 ${link.linkCode} 已归档，不能切换目标`)
    }
    const newSeal = this.state.seals[newTargetSealId]
    if (!newSeal || newSeal.role !== 'target') {
      throw new Error(`目标签章 ${newTargetSealId} 不存在或不是目标端签章`)
    }
    if (newSeal.status !== 'active') {
      throw new Error(`目标连接 ${newSeal.endpointCode} 签章未获批，不能作为新目标`)
    }
    const oldTargetId = link.targetSealId
    link.targetSealId = newSeal.sealId
    link.targetSealVersion = newSeal.version
    // 旧目标水位作废：新目标从 0 开始，禁止继承旧源水位
    link.targetWatermark = null
    for (const shard of link.shards) {
      if (shard.state === 'delivered') {
        // 旧目标上的写入对新目标全部成为缺口；确认键按新目标重新生成，
        // 这样恢复重投不会被旧目标的 confirmIndex 幂等索引短路，但同一新键仍只写一次。
        shard.state = 'gap'
        shard.targetWatermark = null
        shard.deliveredAt = null
        shard.targetSealVersion = newSeal.version
        shard.confirmKey = this.buildConfirmKey(link, shard.shardNo)
      }
    }
    link.updatedAt = this.now()
    const eligibility = this.evaluateEligibility(link)
    const to: SyncStatus = eligibility.eligible ? 'recovering' : 'blocked'
    link.status = to
    link.blockedReason = eligibility.eligible ? null : eligibility.reason
    this.record(
      link,
      'switch',
      'switch_target',
      from,
      to,
      `目标端 ${oldTargetId} → ${newSeal.sealId}（${newSeal.endpointCode}），旧目标水位作废，${link.shards.filter((s) => s.state === 'gap').length} 个分片待缺口重投`,
    )
    this.persist()
    return structuredCloneSafe(link)
  }

  /**
   * 恢复同步：重新绑定换发的签章版本，仅处理缺口分片。
   * 任一签章仍撤回则继续阻断；恢复成功后回到运行中。
   */
  recoverSync(linkId: string): SyncLink {
    const link = this.requireLink(linkId)
    const from = link.status
    if (from === 'running' || from === 'archived' || from === 'stopped' || from === 'draft') {
      throw new Error(`链路 ${link.linkCode} 当前状态「${from}」不允许恢复`)
    }
    this.rebindIfReissued(link)
    const eligibility = this.evaluateEligibility(link)
    if (!eligibility.eligible) {
      link.status = 'blocked'
      link.blockedReason = eligibility.reason
      link.updatedAt = this.now()
      this.record(link, 'recover', 'recover', from, 'blocked', `恢复失败：${eligibility.reason}`)
      this.persist()
      throw new Error(`链路 ${link.linkCode} 恢复被资格锁阻断：${eligibility.reason}`)
    }
    link.status = 'recovering'
    link.blockedReason = null
    link.updatedAt = this.now()
    this.record(link, 'recover', 'recover', from, 'recovering', '两端签章恢复有效，开始补齐缺口分片')

    // 只处理缺口分片（含回退待重投），已签收分片原样保留
    const gaps = link.shards
      .filter((shard) => shard.state === 'gap' || shard.state === 'rolledback')
      .sort((a, b) => a.shardNo - b.shardNo)
    const delivered: number[] = []
    for (const shard of gaps) {
      const recheck = this.evaluateEligibility(link)
      if (!recheck.eligible) {
        link.status = 'blocked'
        link.blockedReason = recheck.reason
        this.record(
          link,
          'recover',
          'recover',
          'recovering',
          'blocked',
          `补齐缺口途中签章撤回，停在最后签收分片 #${link.lastAckedShard}：${recheck.reason}`,
        )
        this.persist()
        throw new Error(`链路 ${link.linkCode} 恢复中途阻断，已补 ${delivered.join(',') || '无'}：${recheck.reason}`)
      }
      this.deliverShard(link, shard)
      delivered.push(shard.shardNo)
    }

    const to: SyncStatus = 'running'
    link.status = to
    link.updatedAt = this.now()
    this.record(
      link,
      'recover',
      'recover',
      'recovering',
      to,
      delivered.length
        ? `缺口分片 ${delivered.join(',')} 全部补齐，恢复运行`
        : '无缺口分片，直接恢复运行',
    )
    this.persist()
    return structuredCloneSafe(link)
  }

  /**
   * 演示/测试用：运行计划推进一个分片。
   * 每次推进都重新校验两端资格；阻断时不允许任何新写入。
   */
  pumpShard(linkId: string): SyncLink {
    const link = this.requireLink(linkId)
    if (link.status !== 'running') {
      throw new Error(`链路 ${link.linkCode} 当前「${link.status}」，只有运行中才能推进分片`)
    }
    const eligibility = this.evaluateEligibility(link)
    if (!eligibility.eligible) {
      this.reconcileLink(link, eligibility.reason ?? '资格锁阻断')
      this.persist()
      throw new Error(`链路 ${link.linkCode} 分片推进被阻断：${eligibility.reason}`)
    }
    const nextNo = link.shards.length + 1
    const sourceWatermark = `ws:${String(nextNo).padStart(4, '0')}`
    const shard: Shard = {
      shardNo: nextNo,
      state: 'gap',
      confirmKey: this.buildConfirmKey(link, nextNo),
      sourceWatermark,
      targetWatermark: null,
      sourceSealVersion: link.sourceSealVersion,
      targetSealVersion: link.targetSealVersion,
      deliveredAt: null,
    }
    link.shards.push(shard)
    this.deliverShard(link, shard)
    link.updatedAt = this.now()
    this.persist()
    return structuredCloneSafe(link)
  }

  /** 归档：只接收已停止或已阻断（已停在最后签收分片）的链路。 */
  archiveSync(linkId: string): SyncLink {
    const link = this.requireLink(linkId)
    const from = link.status
    if (from !== 'stopped' && from !== 'blocked') {
      throw new Error(`链路 ${link.linkCode} 当前「${from}」，只有已停止/已阻断链路可以归档`)
    }
    link.status = 'archived'
    link.updatedAt = this.now()
    this.record(link, 'archive', 'archive', from, 'archived', `归档链路，水位定格在分片 #${link.lastAckedShard}`)
    this.persist()
    return structuredCloneSafe(link)
  }

  /**
   * 回退：回退最后一次写入（最后签收分片），confirmIndex 同步释放。
   * 归档链路先回退到已停止；阻断链路回退一个分片后进入恢复中等待补齐。
   */
  rollbackSync(linkId: string): SyncLink {
    const link = this.requireLink(linkId)
    const from = link.status
    if (from === 'draft') {
      throw new Error(`链路 ${link.linkCode} 尚无写入，不能回退`)
    }
    if (from === 'archived') {
      link.status = 'stopped'
      link.updatedAt = this.now()
      this.record(link, 'rollback', 'rollback', from, 'stopped', '归档回退：链路退回已停止')
      this.persist()
      return structuredCloneSafe(link)
    }
    const target = [...link.shards]
      .filter((shard) => shard.state === 'delivered')
      .sort((a, b) => b.shardNo - a.shardNo)[0]
    if (!target) {
      throw new Error(`链路 ${link.linkCode} 没有可回退的已签收分片`)
    }
    target.state = 'rolledback'
    target.targetWatermark = null
    target.deliveredAt = null
    delete this.state.confirmIndex[target.confirmKey]
    const delivered = link.shards.filter((shard) => shard.state === 'delivered')
    link.lastAckedShard = delivered.length ? Math.max(...delivered.map((shard) => shard.shardNo)) : 0
    link.targetWatermark = delivered.length
      ? delivered.sort((a, b) => b.shardNo - a.shardNo)[0].targetWatermark
      : null
    const to: SyncStatus = 'recovering'
    link.status = to
    link.updatedAt = this.now()
    this.record(
      link,
      'rollback',
      'rollback',
      from,
      to,
      `回退分片 #${target.shardNo}，确认键 ${target.confirmKey} 已释放，最后签收分片变为 #${link.lastAckedShard}，等待缺口补齐`,
    )
    this.persist()
    return structuredCloneSafe(link)
  }

  // ---------- 交叉操作：切换目标与停链按锁序号定终态 ----------

  /** 先切换目标、后停止：停止事件锁序号更大，终态为已停止。 */
  switchThenStop(linkId: string, newTargetSealId: string): { link: SyncLink; finalLockSeq: number } {
    this.switchTarget(linkId, newTargetSealId)
    const stopped = this.stopSync(linkId)
    return { link: stopped, finalLockSeq: this.state.lockSeq }
  }

  /** 先停止、后切换目标：切换事件锁序号更大，终态为阻断或恢复中（不会重新运行）。 */
  stopThenSwitch(linkId: string, newTargetSealId: string): { link: SyncLink; finalLockSeq: number } {
    this.stopSync(linkId)
    const switched = this.switchTarget(linkId, newTargetSealId)
    return { link: switched, finalLockSeq: this.state.lockSeq }
  }

  /** 按锁序号取链路的终态判定事件（交叉操作终态依据）。 */
  terminalEvent(linkId: string): LifecycleEvent {
    const events = this.state.events
      .filter((event) => event.linkId === linkId)
      .sort((a, b) => b.lockSeq - a.lockSeq)
    if (!events.length) throw new Error(`链路 ${linkId} 暂无生命周期事件`)
    return { ...events[0] }
  }

  // ---------- 内部工具 ----------

  private reconcileLink(link: SyncLink, reason: string): void {
    const eligibility = this.evaluateEligibility(link)
    if (eligibility.eligible) {
      return
    }
    if (link.status === 'running' || link.status === 'recovering') {
      const from = link.status
      link.status = 'blocked'
      link.blockedReason = eligibility.reason ?? reason
      link.updatedAt = this.now()
      this.record(
        link,
        'switch',
        'seal_revoked',
        from,
        'blocked',
        `资格锁阻断，停在最后签收分片 #${link.lastAckedShard}：${eligibility.reason ?? reason}`,
      )
    } else {
      link.blockedReason = eligibility.reason ?? reason
    }
  }

  private rebindIfReissued(link: SyncLink): void {
    const sourceSeal = this.state.seals[link.sourceSealId]
    const targetSeal = this.state.seals[link.targetSealId]
    if (sourceSeal && sourceSeal.status === 'active' && sourceSeal.version !== link.sourceSealVersion) {
      const oldVersion = link.sourceSealVersion
      link.sourceSealVersion = sourceSeal.version
      this.record(
        link,
        'recover',
        'seal_reissued',
        link.status,
        link.status,
        `重新绑定源端签章 v${oldVersion} → v${sourceSeal.version}`,
      )
    }
    if (targetSeal && targetSeal.status === 'active' && targetSeal.version !== link.targetSealVersion) {
      const oldVersion = link.targetSealVersion
      link.targetSealVersion = targetSeal.version
      this.record(
        link,
        'recover',
        'seal_reissued',
        link.status,
        link.status,
        `重新绑定目标端签章 v${oldVersion} → v${targetSeal.version}`,
      )
    }
  }

  private buildConfirmKey(link: SyncLink, shardNo: number): string {
    return `${link.linkCode}:${link.targetSealId}:v${link.targetSealVersion}:#${shardNo}`
  }

  /**
   * 分片投递：确认键幂等。
   * 目标水位只由当前目标上的已投递分片推进，源水位只随分片携带，不直接写入目标。
   */
  private deliverShard(link: SyncLink, shard: Shard): void {
    if (this.state.confirmIndex[shard.confirmKey]) {
      // 同一确认键已经写入过：直接返回，不产生第二份写入
      return
    }
    shard.state = 'delivered'
    shard.sourceSealVersion = link.sourceSealVersion
    shard.targetSealVersion = link.targetSealVersion
    // 目标水位基于已投递分片单调推进，绝不复制旧目标/旧源水位
    shard.targetWatermark = `wt:${String(shard.shardNo).padStart(4, '0')}`
    shard.deliveredAt = this.now()
    this.state.confirmIndex[shard.confirmKey] = link.linkId
    link.lastAckedShard = Math.max(link.lastAckedShard, shard.shardNo)
    link.targetWatermark = shard.targetWatermark
  }

  // ---------- 重置（仅演示/测试） ----------

  reset(): void {
    this.state = emptyStore()
    this.persist()
    this.seed()
  }

  // ---------- 示例数据：复现 DATA-0001 绿灯故障并展示修补后行为 ----------

  private seed(): void {
    const seals: EndpointSeal[] = [
      {
        sealId: 'seal-src-0001',
        role: 'source',
        endpointCode: 'SOUR-0001',
        endpointName: '订单库源端连接',
        status: 'revoked',
        version: 2,
        reason: '源端连接印章已摘除（v1 撤回，v2 待重绑）',
        updatedAt: '2026-11-13T09:00:00.000Z',
      },
      {
        sealId: 'seal-src-0002',
        role: 'source',
        endpointCode: 'SOUR-0002',
        endpointName: '日志库源端连接',
        status: 'active',
        version: 1,
        reason: '签章有效',
        updatedAt: '2026-11-13T09:00:00.000Z',
      },
      {
        sealId: 'seal-tgt-0001',
        role: 'target',
        endpointCode: 'ODS-0001',
        endpointName: '贴源层主目标',
        status: 'active',
        version: 1,
        reason: '签章有效',
        updatedAt: '2026-11-13T09:00:00.000Z',
      },
      {
        sealId: 'seal-tgt-0002',
        role: 'target',
        endpointCode: 'ODS-0009',
        endpointName: '未获批备用目标',
        status: 'revoked',
        version: 1,
        reason: '目标连接未获批，签章撤回',
        updatedAt: '2026-11-13T09:00:00.000Z',
      },
      {
        sealId: 'seal-tgt-0003',
        role: 'target',
        endpointCode: 'ODS-0010',
        endpointName: '灾备合规目标',
        status: 'active',
        version: 1,
        reason: '签章有效',
        updatedAt: '2026-11-13T09:00:00.000Z',
      },
    ]
    for (const seal of seals) {
      this.state.seals[seal.sealId] = { ...seal }
    }

    // DATA-0001：复现故障现场——源端摘除、目标曾换未获批连接，修补后链路必须是阻断红灯
    const link1 = this.buildSeedLink({
      linkId: 'link-data-0001',
      linkCode: 'DATA-0001',
      linkName: '订单库 → 贴源层主同步链路',
      sourceSealId: 'seal-src-0001',
      sourceSealVersion: 1, // 计划绑定的是已撤回的旧版本
      targetSealId: 'seal-tgt-0001',
      targetSealVersion: 1,
      shardCount: 5,
      deliveredUpTo: 3,
      status: 'blocked',
      blockedReason:
        '源端连接 SOUR-0001：签章已换发（计划绑定 v1，当前 v2），已摘除/撤回或未获批；目标端曾切换未获批连接 ODS-0009',
    })
    this.state.links[link1.linkId] = link1

    // DATA-0002：健康链路，两端签章有效，可推进分片、可演练撤回/恢复
    const link2 = this.buildSeedLink({
      linkId: 'link-data-0002',
      linkCode: 'DATA-0002',
      linkName: '日志库 → 贴源层主同步链路',
      sourceSealId: 'seal-src-0002',
      sourceSealVersion: 1,
      targetSealId: 'seal-tgt-0001',
      targetSealVersion: 1,
      shardCount: 4,
      deliveredUpTo: 4,
      status: 'running',
      blockedReason: null,
    })
    this.state.links[link2.linkId] = link2

    // DATA-0003：已停止并归档的链路，演示生命周期留痕与回退
    const link3 = this.buildSeedLink({
      linkId: 'link-data-0003',
      linkCode: 'DATA-0003',
      linkName: '历史归档同步链路',
      sourceSealId: 'seal-src-0002',
      sourceSealVersion: 1,
      targetSealId: 'seal-tgt-0003',
      targetSealVersion: 1,
      shardCount: 2,
      deliveredUpTo: 2,
      status: 'archived',
      blockedReason: null,
    })
    this.state.links[link3.linkId] = link3

    this.state.seeded = true
    this.state.lockSeq = 0
    this.state.events = []
    // 为播种链路补全生命周期事件，锁序号从 1 开始，后续变更严格递增
    this.seedEvents(link1, [
      ['switch', 'start', 'draft', 'running', '两端签章均有效，启动同步'],
      ['switch', 'shard_deliver', 'running', 'running', '分片 #1-#3 签收'],
      ['switch', 'seal_revoked', 'running', 'blocked', '资格锁阻断，停在最后签收分片 #3：源端连接 SOUR-0001 已摘除/撤回'],
    ])
    this.seedEvents(link2, [
      ['switch', 'start', 'draft', 'running', '两端签章均有效，启动同步'],
      ['switch', 'shard_deliver', 'running', 'running', '分片 #1-#4 签收'],
    ])
    this.seedEvents(link3, [
      ['switch', 'start', 'draft', 'running', '两端签章均有效，启动同步'],
      ['switch', 'shard_deliver', 'running', 'running', '分片 #1-#2 签收'],
      ['switch', 'stop', 'running', 'stopped', '停止同步，停在最后签收分片 #2'],
      ['archive', 'archive', 'stopped', 'archived', '归档链路，水位定格在分片 #2'],
    ])
    this.persist()
  }

  private seedEvents(
    link: SyncLink,
    rows: Array<[LifecycleStage, EventAction, SyncStatus, SyncStatus, string]>,
  ): void {
    for (const [stage, action, fromStatus, toStatus, detail] of rows) {
      this.state.events.push({
        lockSeq: this.nextLockSeq(),
        linkId: link.linkId,
        stage,
        action,
        fromStatus,
        toStatus,
        detail,
        at: this.now(),
      })
    }
  }

  private buildSeedLink(params: {
    linkId: string
    linkCode: string
    linkName: string
    sourceSealId: string
    sourceSealVersion: number
    targetSealId: string
    targetSealVersion: number
    shardCount: number
    deliveredUpTo: number
    status: SyncStatus
    blockedReason: string | null
  }): SyncLink {
    const shards: Shard[] = []
    let lastAcked = 0
    let targetWatermark: string | null = null
    for (let no = 1; no <= params.shardCount; no += 1) {
      const delivered = no <= params.deliveredUpTo
      const confirmKey = `${params.linkCode}:${params.targetSealId}:v${params.targetSealVersion}:#${no}`
      if (delivered) {
        this.state.confirmIndex[confirmKey] = params.linkId
        lastAcked = no
        targetWatermark = `wt:${String(no).padStart(4, '0')}`
      }
      shards.push({
        shardNo: no,
        state: delivered ? 'delivered' : 'gap',
        confirmKey,
        sourceWatermark: `ws:${String(no).padStart(4, '0')}`,
        targetWatermark: delivered ? `wt:${String(no).padStart(4, '0')}` : null,
        sourceSealVersion: params.sourceSealVersion,
        targetSealVersion: params.targetSealVersion,
        deliveredAt: delivered ? '2026-11-13T09:00:00.000Z' : null,
      })
    }
    return {
      linkId: params.linkId,
      linkCode: params.linkCode,
      linkName: params.linkName,
      status: params.status,
      sourceSealId: params.sourceSealId,
      sourceSealVersion: params.sourceSealVersion,
      targetSealId: params.targetSealId,
      targetSealVersion: params.targetSealVersion,
      lastAckedShard: lastAcked,
      targetWatermark,
      blockedReason: params.blockedReason,
      shards,
      updatedAt: '2026-11-13T09:00:00.000Z',
    }
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 默认单例：浏览器环境落 localStorage，无 localStorage 时退化为内存存储 */
export const syncLockEngine = new SyncLockEngine()

export function createEngine(storage?: LockStorage, clock?: Clock): SyncLockEngine {
  return new SyncLockEngine(storage, clock)
}

export function sealLabel(seal: EndpointSeal): string {
  const role: Record<EndpointRole, string> = { source: '源端', target: '目标端' }
  return `${role[seal.role]} ${seal.endpointCode} v${seal.version}`
}
