<template>
  <section class="page" data-module="monitor">
    <header class="page-head">
      <div>
        <h2>任务监控管理</h2>
        <p class="page-desc">
          监控读数与数据同步、数据源读取同一份阻断凭据：两端任一签章撤回，链路一律红灯，
          不再出现“链路挂着运行绿灯、延迟读数正常”的假象；延迟只反映最后签收分片。
        </p>
      </div>
    </header>

    <h3 style="margin: 8px 0">同步链路监控（MONI 读数 · 与资格锁同源）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>监控编号</th>
          <th>链路</th>
          <th>运行终态</th>
          <th>信号灯</th>
          <th>阻断原因（同源凭据）</th>
          <th>最后签收分片</th>
          <th>缺口分片</th>
          <th>源水位</th>
          <th>目标水位</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in readouts" :key="item.linkId">
          <td class="mono">MONI-{{ item.linkCode }}</td>
          <td>{{ item.linkCode }}</td>
          <td>{{ statusLabel(item.linkStatus) }}</td>
          <td>
            <span class="badge" :class="item.lamp">{{ lampLabel(item.lamp) }}</span>
          </td>
          <td>{{ item.blocked ? item.blockedReason : '—' }}</td>
          <td>#{{ item.lastAckedShard }}</td>
          <td>{{ item.gapShards.length ? '#' + item.gapShards.join('、#') : '无' }}</td>
          <td class="mono">{{ item.sourceWatermark ?? '—' }}</td>
          <td class="mono">{{ item.targetWatermark ?? '—（新目标未写入）' }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="redCount" class="credential-banner" style="margin-top: 12px">
      <strong>{{ redCount }} 条链路红灯：</strong>监控不再对阻断链路报绿灯，延迟读数停在最后签收分片，恢复后仅补缺口。
    </div>
    <div v-else class="credential-banner clear" style="margin-top: 12px">全部链路资格有效，监控灯与同步终态一致。</div>

    <h3 style="margin: 16px 0 8px">监控配置台账（脚手架数据）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>红灯 {{ redCount }} · 黄灯 {{ amberCount }} · 绿灯 {{ greenCount }}</span>
      <span v-if="message" :class="messageOk ? '' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { lampLabel, statusLabel, syncLockService } from '@/domain/sync-lock/service'
import type { MonitorReadout } from '@/domain/sync-lock/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('monitor')
const columns = ['配置编号', '关联任务', '监控指标', '告警阈值', '告警级别', '静默分钟', '通知渠道', '恢复条件']
const actions = ['提交校验', '启用监控', '停用监控']

// 监控页不自己判断链路状态：全部读数来自引擎 getMonitorReadout，与阻断凭据同源
const readouts = computed<MonitorReadout[]>(() =>
  syncLockService.listLinks().map((link) => syncLockService.getMonitorReadout(link.linkId)),
)
const redCount = computed(() => readouts.value.filter((item) => item.lamp === 'red').length)
const amberCount = computed(() => readouts.value.filter((item) => item.lamp === 'amber').length)
const greenCount = computed(() => readouts.value.filter((item) => item.lamp === 'green').length)

const rows = ref<EntryRow[]>([])
const message = ref('')
const messageOk = ref(true)

function runAction(action: string, row: EntryRow): void {
  const result = applyAction(meta.key, Number(row.id), action)
  messageOk.value = result.ok
  message.value = result.message
  if (result.ok) {
    rows.value = listEntries(meta.key).items
  }
}

onMounted(() => {
  rows.value = listEntries(meta.key).items
})
</script>
