import {
  createEngine,
  sealLabel,
  syncLockEngine,
  type Clock,
} from './engine'
import {
  STATUS_LABEL,
  STAGE_LABEL,
  type BlockingCredential,
  type EndpointRole,
  type EndpointSeal,
  type LifecycleEvent,
  type LockStorage,
  type MonitorReadout,
  type Shard,
  type SyncLink,
  type SyncStatus,
} from './types'

export type {
  BlockingCredential,
  EndpointSeal,
  LifecycleEvent,
  MonitorReadout,
  Shard,
  SyncLink,
  SyncStatus,
}

export interface ServiceResult<T> {
  ok: boolean
  message: string
  data?: T
}

/** 页面统一入口：所有动作经服务门面调用，错误转成可读消息，页面不写业务判断。 */
export const syncLockService = {
  listLinks(): SyncLink[] {
    return syncLockEngine.listLinks()
  },
  getLink(linkId: string): SyncLink {
    return syncLockEngine.getLink(linkId)
  },
  listSeals(): EndpointSeal[] {
    return syncLockEngine.listSeals()
  },
  listEvents(linkId?: string): LifecycleEvent[] {
    return syncLockEngine.listEvents(linkId)
  },
  getBlockingCredential(linkId: string): BlockingCredential {
    return syncLockEngine.getBlockingCredential(linkId)
  },
  getMonitorReadout(linkId: string): MonitorReadout {
    return syncLockEngine.getMonitorReadout(linkId)
  },
  terminalEvent(linkId: string): LifecycleEvent {
    return syncLockEngine.terminalEvent(linkId)
  },

  startSync(linkId: string): ServiceResult<SyncLink> {
    return run(() => syncLockEngine.startSync(linkId), '同步已启动')
  },
  stopSync(linkId: string): ServiceResult<SyncLink> {
    return run(() => syncLockEngine.stopSync(linkId), '同步已停止，停在最后签收分片')
  },
  switchTarget(linkId: string, newTargetSealId: string): ServiceResult<SyncLink> {
    return run(() => syncLockEngine.switchTarget(linkId, newTargetSealId), '目标端已切换，旧目标水位已作废')
  },
  recoverSync(linkId: string): ServiceResult<SyncLink> {
    return run(() => syncLockEngine.recoverSync(linkId), '缺口分片已补齐，链路恢复运行')
  },
  pumpShard(linkId: string): ServiceResult<SyncLink> {
    return run(() => syncLockEngine.pumpShard(linkId), '分片已签收')
  },
  archiveSync(linkId: string): ServiceResult<SyncLink> {
    return run(() => syncLockEngine.archiveSync(linkId), '链路已归档')
  },
  rollbackSync(linkId: string): ServiceResult<SyncLink> {
    return run(() => syncLockEngine.rollbackSync(linkId), '已按生命周期执行回退')
  },
  revokeSeal(sealId: string, reason: string): ServiceResult<EndpointSeal> {
    return run(() => syncLockEngine.revokeSeal(sealId, reason), '签章已撤回，相关链路已阻断')
  },
  reissueSeal(sealId: string, reason: string): ServiceResult<EndpointSeal> {
    return run(() => syncLockEngine.reissueSeal(sealId, reason), '签章已换发新版本')
  },
  resetDemo(): ServiceResult<null> {
    syncLockEngine.reset()
    return { ok: true, message: '演示数据已重置', data: null }
  },
}

function run<T>(fn: () => T, success: string): ServiceResult<T> {
  try {
    const data = fn()
    return { ok: true, message: success, data }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '操作失败' }
  }
}

export function createSyncLockEngine(storage?: LockStorage, clock?: Clock) {
  return createEngine(storage, clock)
}

export function statusLabel(status: SyncStatus): string {
  return STATUS_LABEL[status]
}

export function stageLabel(stage: LifecycleEvent['stage']): string {
  return STAGE_LABEL[stage]
}

export function roleLabel(role: EndpointRole): string {
  return role === 'source' ? '源端' : '目标端'
}

export function shardStateLabel(state: Shard['state']): string {
  switch (state) {
    case 'delivered':
      return '已签收'
    case 'gap':
      return '缺口'
    case 'rolledback':
      return '已回退'
  }
}

export function lampLabel(lamp: MonitorReadout['lamp']): string {
  switch (lamp) {
    case 'green':
      return '绿灯'
    case 'amber':
      return '黄灯'
    case 'red':
      return '红灯'
  }
}

export { sealLabel }
