<template>
  <section class="page" data-module="datasync">
    <header class="page-head">
      <div>
        <h2>数据同步管理</h2>
        <p class="page-desc">
          运行计划同时绑定源端、目标端当前签章（两端资格锁）：任一签章撤回即停在最后签收分片，恢复只补缺口分片，
          切换目标后旧源水位不写入新目标；列表与详情读取同一份引擎数据。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetDemo">重置演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="blockedLinks.length" class="credential-banner">
      <strong>阻断凭据（同步 / 数据源 / 任务监控同源）：</strong>
      <ul>
        <li v-for="item in blockedLinks" :key="item.linkId">
          {{ item.linkCode }} 红灯阻断：{{ item.reason }}（锁序号 {{ item.lockSeq }}）
        </li>
      </ul>
    </div>
    <div v-else class="credential-banner clear">当前无阻断链路，全部链路两端签章有效。</div>

    <table class="data-table">
      <thead>
        <tr>
          <th>链路编号</th>
          <th>链路名称</th>
          <th>运行终态</th>
          <th>源端签章（绑定版本）</th>
          <th>目标端签章（绑定版本）</th>
          <th>最后签收分片</th>
          <th>目标水位</th>
          <th>监控灯</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in links" :key="row.linkId" class="clickable" @click="openDetail(row.linkId)">
          <td class="mono">{{ row.linkCode }}</td>
          <td>{{ row.linkName }}</td>
          <td><span class="badge" :class="statusClass(row.status)">{{ statusLabel(row.status) }}</span></td>
          <td>
            {{ sealOf(row.sourceSealId)?.endpointCode ?? '—' }}
            <span class="mono">v{{ row.sourceSealVersion }}</span>
            <span class="badge" :class="sealOf(row.sourceSealId)?.status === 'active' ? 'green' : 'red'">
              {{ sealOf(row.sourceSealId)?.status === 'active' ? '有效' : '撤回' }}
            </span>
          </td>
          <td>
            {{ sealOf(row.targetSealId)?.endpointCode ?? '—' }}
            <span class="mono">v{{ row.targetSealVersion }}</span>
            <span class="badge" :class="sealOf(row.targetSealId)?.status === 'active' ? 'green' : 'red'">
              {{ sealOf(row.targetSealId)?.status === 'active' ? '有效' : '未获批' }}
            </span>
          </td>
          <td>#{{ row.lastAckedShard }} / {{ row.shards.length }}</td>
          <td class="mono">{{ row.targetWatermark ?? '—（新目标未写入）' }}</td>
          <td><span class="badge" :class="readoutOf(row.linkId).lamp">{{ lampLabel(readoutOf(row.linkId).lamp) }}</span></td>
          <td class="row-actions" @click.stop>
            <button class="link" type="button" @click="openDetail(row.linkId)">详情</button>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ links.length }} 条同步链路 · 阻断 {{ blockedLinks.length }} 条</span>
      <span v-if="message" :class="messageOk ? '' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 详情抽屉：与列表同一份引擎数据，避免列表显示旧值、详情丢新值 -->
    <template v-if="selected">
      <div class="drawer-mask" @click="closeDetail" />
      <aside class="drawer">
        <div class="drawer-head">
          <div>
            <h3>{{ selected.linkCode }} 同步链路详情</h3>
            <span class="badge" :class="statusClass(selected.status)">{{ statusLabel(selected.status) }}</span>
          </div>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </div>

        <div v-if="credential.blocked" class="credential-banner">
          阻断原因：{{ credential.reason }}<br />
          撤回签章：{{ credential.revokedSealIds.join('、') || '（版本失效）' }} · 锁序号 {{ credential.lockSeq }}
        </div>
        <div v-else class="credential-banner clear">两端签章均有效，资格锁放行（锁序号 {{ credential.lockSeq }}）。</div>

        <div class="drawer-section">
          <h4>运行计划绑定与增量水位（回看核对主对象）</h4>
          <dl class="kv-grid">
            <dt>源端签章</dt><dd>{{ sealLabel(sealOf(selected.sourceSealId)!) }} · 绑定 v{{ selected.sourceSealVersion }}</dd>
            <dt>目标端签章</dt><dd>{{ sealLabel(sealOf(selected.targetSealId)!) }} · 绑定 v{{ selected.targetSealVersion }}</dd>
            <dt>最后签收分片</dt><dd>#{{ selected.lastAckedShard }}</dd>
            <dt>目标端水位</dt><dd class="mono">{{ selected.targetWatermark ?? '空（切换目标后禁止继承旧源水位）' }}</dd>
            <dt>最新源端水位</dt><dd class="mono">{{ readout.sourceWatermark ?? '—' }}</dd>
            <dt>缺口分片</dt><dd>{{ readout.gapShards.length ? '#' + readout.gapShards.join('、#') : '无' }}</dd>
          </dl>
        </div>

        <div class="drawer-section">
          <h4>分片签收（恢复只处理缺口，确认键全局唯一）</h4>
          <table class="shard-table">
            <thead>
              <tr><th>分片</th><th>状态</th><th>源水位</th><th>目标水位</th><th>确认键</th></tr>
            </thead>
            <tbody>
              <tr v-for="shard in selected.shards" :key="shard.shardNo">
                <td>#{{ shard.shardNo }}</td>
                <td><span class="badge" :class="shardClass(shard.state)">{{ shardStateLabel(shard.state) }}</span></td>
                <td class="mono">{{ shard.sourceWatermark }}</td>
                <td class="mono">{{ shard.targetWatermark ?? '—' }}</td>
                <td class="mono" style="font-size:11px">{{ shard.confirmKey }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="drawer-section">
          <h4>生命周期（状态切换 → 恢复 → 归档 → 回退，按锁序号留痕）</h4>
          <ol class="timeline">
            <li v-for="event in eventsOf(selected.linkId)" :key="event.lockSeq">
              <div class="t-head">#{{ event.lockSeq }} {{ stageLabel(event.stage) }} · {{ actionLabel(event.action) }}</div>
              <div>{{ statusLabel(event.fromStatus) }} → {{ statusLabel(event.toStatus) }}：{{ event.detail }}</div>
              <div class="t-meta">{{ event.at }}</div>
            </li>
          </ol>
        </div>

        <div class="drawer-section">
          <h4>链路动作</h4>
          <div class="drawer-actions">
            <button class="btn primary" type="button" :disabled="!canStart" @click="act('start')">启动同步</button>
            <button class="btn" type="button" :disabled="!canStop" @click="act('stop')">停止同步</button>
            <button class="btn" type="button" :disabled="!canRecover" @click="act('recover')">恢复（补缺口）</button>
            <button class="btn" type="button" :disabled="!canPump" @click="act('pump')">推进分片</button>
            <button class="btn" type="button" :disabled="!canArchive" @click="act('archive')">归档</button>
            <button class="btn" type="button" :disabled="!canRollback" @click="act('rollback')">回退</button>
          </div>
          <form class="inline-form" @submit.prevent="switchTarget">
            <span>切换目标：</span>
            <select v-model="nextTargetSealId">
              <option v-for="seal in targetSeals" :key="seal.sealId" :value="seal.sealId" :disabled="seal.status !== 'active'">
                {{ seal.endpointCode }} v{{ seal.version }}{{ seal.status === 'active' ? '' : '（未获批，禁选）' }}
              </option>
            </select>
            <button class="btn" type="submit" :disabled="!canSwitch">切换目标（旧水位作废）</button>
          </form>
          <p class="page-desc">交叉演练：
            <button class="link" type="button" @click="cross('switchThenStop')">先切换后停止</button> ·
            <button class="link" type="button" @click="cross('stopThenSwitch')">先停止后切换</button>
            ，终态以最大锁序号事件为准。
          </p>
        </div>
      </aside>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { syncLockEngine } from '@/domain/sync-lock/engine'
import {
  lampLabel,
  sealLabel,
  shardStateLabel,
  stageLabel,
  statusLabel,
  syncLockService,
} from '@/domain/sync-lock/service'
import type {
  EndpointSeal,
  EventAction,
  LifecycleEvent,
  Shard,
  SyncLink,
  SyncStatus,
} from '@/domain/sync-lock/types'

// 页面不缓存列表数据：每次渲染都从引擎取，保证列表与详情永远是同一份新值
const tick = ref(0)
const links = computed<SyncLink[]>(() => {
  void tick.value
  return syncLockService.listLinks()
})
const seals = computed<EndpointSeal[]>(() => {
  void tick.value
  return syncLockService.listSeals()
})
const targetSeals = computed(() => seals.value.filter((seal) => seal.role === 'target'))
const selectedId = ref<string | null>(null)
const selected = computed<SyncLink | null>(() => {
  void tick.value
  return selectedId.value ? syncLockService.getLink(selectedId.value) : null
})
const credential = computed(() => {
  void tick.value
  return selectedId.value
    ? syncLockService.getBlockingCredential(selectedId.value)
    : { blocked: false, reason: null, revokedSealIds: [], lockSeq: 0, at: '', linkId: '', linkCode: '', sourceSealId: '', targetSealId: '' }
})
const readout = computed(() => {
  void tick.value
  return selectedId.value
    ? syncLockService.getMonitorReadout(selectedId.value)
    : { lamp: 'green' as const, gapShards: [], lastAckedShard: 0, targetWatermark: null, sourceWatermark: null, blocked: false, blockedReason: null, linkStatus: 'draft' as SyncStatus, linkId: '', linkCode: '', at: '' }
})
const nextTargetSealId = ref('')
const message = ref('')
const messageOk = ref(true)

const blockedLinks = computed(() =>
  links.value
    .map((link) => syncLockService.getBlockingCredential(link.linkId))
    .filter((item) => item.blocked),
)

const stats = computed(() => {
  const rows = links.value
  return [
    { label: '同步链路总数', value: rows.length },
    { label: '运行中链路', value: rows.filter((row) => row.status === 'running').length },
    { label: '阻断链路（红灯）', value: blockedLinks.value.length },
  ]
})

const canStart = computed(() => selected.value && ['draft', 'recovering'].includes(selected.value.status))
const canStop = computed(() => selected.value && ['running', 'blocked', 'recovering'].includes(selected.value.status))
const canRecover = computed(() => selected.value && ['blocked', 'recovering'].includes(selected.value.status))
const canPump = computed(() => selected.value?.status === 'running')
const canArchive = computed(() => selected.value && ['stopped', 'blocked'].includes(selected.value.status))
const canRollback = computed(() => selected.value && selected.value.status !== 'draft')
const canSwitch = computed(
  () => selected.value && selected.value.status !== 'archived' && nextTargetSealId.value && nextTargetSealId.value !== selected.value.targetSealId,
)

function refresh(): void {
  tick.value += 1
}

function sealOf(sealId: string): EndpointSeal | undefined {
  return seals.value.find((seal) => seal.sealId === sealId)
}

function readoutOf(linkId: string) {
  return syncLockService.getMonitorReadout(linkId)
}

function eventsOf(linkId: string): LifecycleEvent[] {
  return syncLockService.listEvents(linkId).sort((a, b) => a.lockSeq - b.lockSeq)
}

function openDetail(linkId: string): void {
  selectedId.value = linkId
  const link = syncLockService.getLink(linkId)
  nextTargetSealId.value = link.targetSealId
  message.value = ''
}

function closeDetail(): void {
  selectedId.value = null
}

function notify(ok: boolean, text: string): void {
  messageOk.value = ok
  message.value = text
  refresh()
}

function act(kind: 'start' | 'stop' | 'recover' | 'pump' | 'archive' | 'rollback'): void {
  if (!selectedId.value) return
  const actions = {
    start: syncLockService.startSync,
    stop: syncLockService.stopSync,
    recover: syncLockService.recoverSync,
    pump: syncLockService.pumpShard,
    archive: syncLockService.archiveSync,
    rollback: syncLockService.rollbackSync,
  } as const
  const result = actions[kind](selectedId.value)
  notify(result.ok, result.message)
}

function switchTarget(): void {
  if (!selectedId.value || !nextTargetSealId.value) return
  const result = syncLockService.switchTarget(selectedId.value, nextTargetSealId.value)
  notify(result.ok, result.message)
}

function cross(kind: 'switchThenStop' | 'stopThenSwitch'): void {
  if (!selectedId.value || !nextTargetSealId.value) return
  const linkId = selectedId.value
  const targetId = nextTargetSealId.value
  const outcome = kind === 'switchThenStop'
    ? syncLockEngine.switchThenStop(linkId, targetId)
    : syncLockEngine.stopThenSwitch(linkId, targetId)
  const terminal = syncLockService.terminalEvent(linkId)
  notify(
    true,
    `交叉操作终态「${statusLabel(outcome.link.status)}」，由锁序号 #${terminal.lockSeq} 的「${stageLabel(terminal.stage)}」事件定终态`,
  )
}

function resetDemo(): void {
  const result = syncLockService.resetDemo()
  selectedId.value = null
  notify(result.ok, result.message)
}

function statusClass(status: SyncStatus): string {
  switch (status) {
    case 'running':
      return 'green'
    case 'recovering':
      return 'amber'
    case 'blocked':
      return 'red'
    case 'archived':
      return 'gray'
    default:
      return 'blue'
  }
}

function shardClass(state: Shard['state']): string {
  switch (state) {
    case 'delivered':
      return 'green'
    case 'gap':
      return 'amber'
    case 'rolledback':
      return 'gray'
  }
}

function actionLabel(action: EventAction): string {
  const labels: Record<EventAction, string> = {
    seal_revoked: '签章撤回',
    seal_reissued: '签章换发',
    start: '启动',
    stop: '停止',
    switch_target: '切换目标',
    recover: '恢复',
    shard_deliver: '分片签收',
    archive: '归档',
    rollback: '回退',
  }
  return labels[action]
}
</script>

<style scoped>
.clickable { cursor: pointer; }
.clickable:hover { background: #f8fafc; }
</style>
