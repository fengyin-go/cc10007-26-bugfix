/**
 * 两端资格锁领域模型：数据同步链路的运行计划必须同时绑定源端、目标端各自的当前签章。
 * 任一签章撤回（断开 / 未获批）时，链路停在最后签收分片，恢复后只补缺口分片。
 */

/** 签章角色：源端连接或目标端连接 */
export type EndpointRole = 'source' | 'target'

/** 签章状态：有效=已获批且连接在用；撤回=连接摘除或资格未获批 */
export type SealStatus = 'active' | 'revoked'

/** 链路运行终态 */
export type SyncStatus = 'draft' | 'recovering' | 'running' | 'blocked' | 'stopped' | 'archived'

/** 分片签收状态：缺口/待处理、已签收、已回退 */
export type ShardState = 'gap' | 'delivered' | 'rolledback'

/** 生命周期阶段：状态切换 → 恢复 → 归档 → 回退，按此顺序留痕 */
export type LifecycleStage = 'switch' | 'recover' | 'archive' | 'rollback'

/** 事件来源动作 */
export type EventAction =
  | 'seal_revoked'
  | 'seal_reissued'
  | 'start'
  | 'stop'
  | 'switch_target'
  | 'recover'
  | 'shard_deliver'
  | 'archive'
  | 'rollback'

/** 端点签章（资格凭据） */
export interface EndpointSeal {
  sealId: string
  role: EndpointRole
  /** 对接脚手架里的连接编号，如 SOUR-0001 */
  endpointCode: string
  endpointName: string
  status: SealStatus
  /** 签章版本：撤回后重发会换新版本，旧版本不再有效 */
  version: number
  reason: string
  updatedAt: string
}

/** 同步分片与签收记录 */
export interface Shard {
  shardNo: number
  state: ShardState
  /** 幂等确认键：同一确认键全局只允许一份写入 */
  confirmKey: string
  /** 该分片携带的源端水位（源端读取位置） */
  sourceWatermark: string
  /** 写入目标端后推进的目标水位；未投递到当前目标时为 null */
  targetWatermark: string | null
  /** 投递时锁定的两端签章版本，用于回看核对 */
  sourceSealVersion: number
  targetSealVersion: number
  deliveredAt: string | null
}

/** 生命周期事件，按锁序号严格递增 */
export interface LifecycleEvent {
  /** 锁序号：所有变更入口统一领取的全局单调序号，决定交叉操作终态 */
  lockSeq: number
  linkId: string
  stage: LifecycleStage
  action: EventAction
  fromStatus: SyncStatus
  toStatus: SyncStatus
  detail: string
  at: string
}

/** 同步链路聚合根 */
export interface SyncLink {
  linkId: string
  linkCode: string
  linkName: string
  status: SyncStatus
  /** 运行计划绑定的源端签章 id 与版本 */
  sourceSealId: string
  sourceSealVersion: number
  /** 运行计划绑定的目标端签章 id 与版本 */
  targetSealId: string
  targetSealVersion: number
  /** 最后签收分片号；阻断时就停在这里，不再前进 */
  lastAckedShard: number
  /** 当前目标端已推进水位；切换目标后重置为 null，绝不把旧源水位写进新目标 */
  targetWatermark: string | null
  /** 阻断原因（两端资格锁凭据），未阻断为 null */
  blockedReason: string | null
  shards: Shard[]
  updatedAt: string
}

/** 阻断凭据：同步、source、监控三处读取同一份 */
export interface BlockingCredential {
  linkId: string
  linkCode: string
  blocked: boolean
  reason: string | null
  /** 被撤回/未获批的签章 id 列表 */
  revokedSealIds: string[]
  sourceSealId: string
  targetSealId: string
  lockSeq: number
  at: string
}

/** 监控读取视图：MONI 延迟读数必须与阻断凭据同源，阻断时不报绿灯 */
export interface MonitorReadout {
  linkId: string
  linkCode: string
  linkStatus: SyncStatus
  blocked: boolean
  blockedReason: string | null
  lastAckedShard: number
  /** 缺口分片号列表：恢复只处理这些 */
  gapShards: number[]
  targetWatermark: string | null
  sourceWatermark: string | null
  /** 绿灯/黄灯/红灯，阻断一律红灯，不允许出现“链路挂着绿灯” */
  lamp: 'green' | 'amber' | 'red'
  at: string
}

/** 持久化根对象 */
export interface SyncLockStore {
  version: number
  /** 全局锁序号计数器，所有变更入口统一领取，保证交叉操作终态可判定 */
  lockSeq: number
  seals: Record<string, EndpointSeal>
  links: Record<string, SyncLink>
  events: LifecycleEvent[]
  /** confirmKey -> linkId，保证同一确认键不产生两份写入 */
  confirmIndex: Record<string, string>
  seeded: boolean
}

/** 可注入的 KV 存储，浏览器用 localStorage，验证脚本用内存实现 */
export interface LockStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const LIFECYCLE_ORDER: LifecycleStage[] = ['switch', 'recover', 'archive', 'rollback']

export const STAGE_LABEL: Record<LifecycleStage, string> = {
  switch: '状态切换',
  recover: '恢复',
  archive: '归档',
  rollback: '回退',
}

export const STATUS_LABEL: Record<SyncStatus, string> = {
  draft: '草稿',
  recovering: '恢复中',
  running: '运行中',
  blocked: '已阻断',
  stopped: '已停止',
  archived: '已归档',
}
