<template>
  <section class="page" data-module="source">
    <header class="page-head">
      <div>
        <h2>数据源管理</h2>
        <p class="page-desc">
          连接签章是两端资格锁的资格凭据：撤回签章等于摘除连接/换成未获批连接，所有绑定它的同步链路立即阻断；
          本页与数据同步、任务监控读取同一份阻断凭据。
        </p>
      </div>
    </header>

    <h3 style="margin: 8px 0">连接签章（资格凭据）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>签章</th>
          <th>角色</th>
          <th>连接编号</th>
          <th>连接名称</th>
          <th>版本</th>
          <th>签章状态</th>
          <th>原因</th>
          <th>受影响链路阻断凭据</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="seal in seals" :key="seal.sealId">
          <td class="mono">{{ seal.sealId }}</td>
          <td>{{ roleLabel(seal.role) }}</td>
          <td class="mono">{{ seal.endpointCode }}</td>
          <td>{{ seal.endpointName }}</td>
          <td class="mono">v{{ seal.version }}</td>
          <td>
            <span class="badge" :class="seal.status === 'active' ? 'green' : 'red'">
              {{ seal.status === 'active' ? '有效' : '已撤回' }}
            </span>
          </td>
          <td>{{ seal.reason }}</td>
          <td>
            <span v-if="blockedBySeal(seal.sealId).length" class="badge red">
              阻断 {{ blockedBySeal(seal.sealId).map((item) => item.linkCode).join('、') }}
            </span>
            <span v-else class="badge green">无阻断</span>
          </td>
          <td class="row-actions">
            <button
              v-if="seal.status === 'active'"
              class="link"
              type="button"
              @click="revoke(seal.sealId)"
            >撤回签章</button>
            <button
              v-else
              class="link"
              type="button"
              @click="reissue(seal.sealId)"
            >重新签发（版本+1）</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="blockedCredentials.length" class="credential-banner" style="margin-top: 12px">
      <strong>当前阻断凭据（与同步、监控同源）：</strong>
      <ul>
        <li v-for="item in blockedCredentials" :key="item.linkId">
          {{ item.linkCode }}：{{ item.reason }}（锁序号 {{ item.lockSeq }}）
        </li>
      </ul>
    </div>

    <h3 style="margin: 16px 0 8px">连接登记台账（脚手架数据）</h3>
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
      <span>共 {{ seals.length }} 枚连接签章 · {{ blockedCredentials.length }} 条阻断凭据</span>
      <span v-if="message" :class="messageOk ? '' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { roleLabel, syncLockService } from '@/domain/sync-lock/service'
import type { BlockingCredential, EndpointSeal } from '@/domain/sync-lock/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('source')
const columns = ['连接编号', '连接类型', '接入地址', '认证方式', '连接池配置', '超时秒数', '重试次数', '负责人']
const actions = ['提交连通', '建立连接', '断开连接']

const tick = ref(0)
const seals = computed<EndpointSeal[]>(() => {
  void tick.value
  return syncLockService.listSeals()
})
const allCredentials = computed<BlockingCredential[]>(() => {
  void tick.value
  return syncLockService.listLinks().map((link) => syncLockService.getBlockingCredential(link.linkId))
})
const blockedCredentials = computed(() => allCredentials.value.filter((item) => item.blocked))

const rows = ref<EntryRow[]>([])
const message = ref('')
const messageOk = ref(true)

function blockedBySeal(sealId: string): BlockingCredential[] {
  return blockedCredentials.value.filter((item) => item.revokedSealIds.includes(sealId))
}

function notify(ok: boolean, text: string): void {
  messageOk.value = ok
  message.value = text
  tick.value += 1
}

function revoke(sealId: string): void {
  const result = syncLockService.revokeSeal(sealId, '值班管理员手动撤回连接签章')
  notify(result.ok, result.message)
}

function reissue(sealId: string): void {
  const result = syncLockService.reissueSeal(sealId, '连接资格重新获批，换发新签章')
  notify(result.ok, `${result.message}，请在数据同步页对阻断链路执行恢复并重新绑定`)
}

function runAction(action: string, row: EntryRow): void {
  const result = applyAction(meta.key, Number(row.id), action)
  notify(result.ok, result.message)
  if (result.ok) {
    rows.value = listEntries(meta.key).items
  }
}

onMounted(() => {
  rows.value = listEntries(meta.key).items
})
</script>
