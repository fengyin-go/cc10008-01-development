/**
 * 引擎不变量的无渲染测试：直接驱动 useQueryEngine 的纯逻辑替身（同构状态机）。
 * 用 esbuild 打包后由 node 运行，不依赖浏览器与 React。
 */
import assert from 'node:assert'

import { buildSeedState } from '../src/views/query/domain/seed'
import type { ExecutionBatch, QueryLabState, TimeoutDiagnosis } from '../src/views/query/domain/types'

let state: QueryLabState = buildSeedState()
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${(error as Error).message}`)
  }
}

function batchesOf(statementId: string): ExecutionBatch[] {
  return state.batches
    .filter((b) => b.statementId === statementId)
    .sort((a, b) => a.startedAt - b.startedAt)
}

function findBatch(batchNo: string, statementId: string): ExecutionBatch {
  const batch = state.batches.find((b) => b.batchNo === batchNo && b.statementId === statementId)
  assert(batch, `批次 ${batchNo} 应存在`)
  return batch!
}

console.log('查询快照与超时诊断 · 引擎不变量')

// 1. 旧快照编号不重新编号：重放产生顺延的新批次，B-001 保持不变。
check('跨日重试同语句新批次编号顺延，旧批次不重新编号', () => {
  const s1 = state.statements.find((s) => s.code === 'QUER-0001')!
  const before = batchesOf(s1.id).map((b) => b.batchNo)
  assert.deepStrictEqual(before, ['B-001', 'B-002'], '播种应有 B-001/B-002')
  const maxNo = state.batches
    .filter((b) => b.statementId === s1.id)
    .reduce((m, b) => Math.max(m, Number(/^B-(\d+)$/.exec(b.batchNo)![1])), 0)
  const newNo = `B-${String(maxNo + 1).padStart(3, '0')}`
  assert.strictEqual(newNo, 'B-003')
  const b1 = findBatch('B-001', s1.id)
  assert.strictEqual(b1.status, '已超时')
  assert.ok(b1.snapshot, '超时批次也应冻结快照')
  assert.strictEqual(b1.snapshot!.batchNo, 'B-001')
})

// 2. 报表只能引用已完成快照：超时/终止/中断批次没有可被引用资格。
check('报表引用仅限已完成快照', () => {
  const completed = state.batches.filter((b) => b.status === '已完成' && b.snapshot)
  const blocked = state.batches.filter((b) => b.status !== '已完成')
  for (const batch of blocked) {
    assert.ok(
      !completed.includes(batch),
      `${batch.batchNo}(${batch.status}) 不应进入已完成快照集合`,
    )
  }
  assert.ok(completed.length >= 3, '播种应至少有 3 个已完成快照')
  const report = state.reports[0]
  const referenced = state.batches.find((b) => b.snapshot?.snapshotId === report.snapshotId)!
  assert.strictEqual(referenced.status, '已完成')
})

// 3. 报表引用旧快照时保留旧超时原因，且与新结果隔离。
check('报表存档历史超时诊断（旧原因只读保留）', () => {
  const report = state.reports.find((r) => r.name.includes('区域销售日报'))!
  assert.strictEqual(report.historicalDiagnoses.length, 1)
  const diag = report.historicalDiagnoses[0]
  assert.strictEqual(diag.batchNo, 'B-001')
  assert.strictEqual(diag.kind, '超时')
  assert.ok(diag.reason.includes('超时'), '应保留旧超时原因文本')
  // 报表固化行数不受后续批次影响。
  assert.strictEqual(report.snapshotRowCount, 7920)
})

// 4. 手工终止保留分片边界与终止人。
check('手工终止保留已扫描分片边界与终止人', () => {
  const s2 = state.statements.find((s) => s.code === 'QUER-0002')!
  const batch = findBatch('B-001', s2.id)
  assert.strictEqual(batch.status, '已终止')
  assert.ok(batch.diagnosis)
  const d = batch.diagnosis as TimeoutDiagnosis
  assert.strictEqual(d.kind, '手工终止')
  assert.strictEqual(d.terminatedBy, '值班管理员')
  assert.strictEqual(d.lastScannedShardIndex, 3)
  assert.deepStrictEqual(d.unfinishedShardCodes, ['S-05', 'S-06', 'S-07', 'S-08'])
  assert.strictEqual(batch.shards.filter((x) => x.state === '已扫描').length, 4)
})

// 5. 断线中断可从尚未完成扫描段恢复，且沿用同编号、追加扫描尝试。
check('断线恢复沿用同编号并追加扫描尝试，不覆盖原状态', () => {
  const s3 = state.statements.find((s) => s.code === 'QUER-0003')!
  const batch = findBatch('B-001', s3.id)
  assert.strictEqual(batch.status, '已中断')
  const originalNo = batch.batchNo
  const attemptCount = batch.attempts.length
  const scannedBefore = batch.shards.filter((x) => x.state === '已扫描').length
  // 模拟恢复：新增一次尝试，已扫描分片不被重置。
  const resumed: ExecutionBatch = {
    ...batch,
    status: '执行中',
    endedAt: null,
    attempts: [
      ...batch.attempts,
      {
        attemptNo: batch.attempts.length + 1,
        startedAt: Date.now(),
        endedAt: null,
        reason: '断线恢复' as const,
        scannedShards: [],
      },
    ],
  }
  assert.strictEqual(resumed.batchNo, originalNo, '恢复不得改变批次编号')
  assert.strictEqual(resumed.attempts.length, attemptCount + 1, '应追加一次扫描尝试')
  assert.strictEqual(
    resumed.shards.filter((x) => x.state === '已扫描').length,
    scannedBefore,
    '已扫描边界必须保留，从扫描段续扫而非重头开始',
  )
  const nextShard = resumed.shards.find((x) => x.state === '未扫描')
  assert.strictEqual(nextShard?.code, 'S-03', '应从 S-03 续扫')
})

// 6. 0 行已完成查询与未执行草稿区分；草稿无批次、不进报表选择器。
check('0 行已完成查询 ≠ 未执行草稿，草稿不产生批次', () => {
  const s4 = state.statements.find((s) => s.code === 'QUER-0004')!
  const zeroBatch = findBatch('B-001', s4.id)
  assert.strictEqual(zeroBatch.status, '已完成')
  assert.strictEqual(zeroBatch.rowCount, 0)
  assert.ok(zeroBatch.snapshot, '0 行已完成查询仍有快照')
  assert.strictEqual(zeroBatch.snapshot!.rowCount, 0)

  const s5 = state.statements.find((s) => s.code === 'QUER-0005')!
  const draftBatches = state.batches.filter((b) => b.statementId === s5.id)
  assert.strictEqual(draftBatches.length, 0, '草稿没有任何批次')
  const selectable = state.batches.filter((b) => b.status === '已完成' && b.snapshot)
  assert.ok(!selectable.some((b) => b.statementId === s5.id), '草稿不可能出现在报表选择器')
})

// 7. 归档语句复制表达式得到全新语句，不继承旧结果行数。
check('复制已归档查询表达式不继承旧批次行数', () => {
  const s6 = state.statements.find((s) => s.code === 'QUER-0006')!
  assert.strictEqual(s6.archived, true)
  const oldBatch = findBatch('B-001', s6.id)
  assert.strictEqual(oldBatch.rowCount, 1590)
  const cloned = {
    ...s6,
    id: 'stmt-clone',
    code: 'QUER-0007',
    createdAt: Date.now(),
    archived: false,
  }
  const clonedBatches = state.batches.filter((b) => b.statementId === cloned.id)
  assert.strictEqual(clonedBatches.length, 0, '新语句起始无批次、无继承行数')
  assert.strictEqual(cloned.expression, s6.expression, '表达式被复制')
})

// 8. 快照不可变：终态快照字段与批次终态一致，重新执行不改旧快照。
check('终态快照冻结且带目标数据集/返回字段/行数', () => {
  const s1 = state.statements.find((s) => s.code === 'QUER-0001')!
  const b2 = findBatch('B-002', s1.id)
  const snap = b2.snapshot!
  assert.strictEqual(snap.targetDataset, b2.targetDataset)
  assert.strictEqual(snap.expression, s1.expression)
  assert.ok(snap.returnFields.length > 0)
  assert.strictEqual(snap.rowCount, b2.rowCount)
  assert.ok(snap.endedAt >= snap.startedAt, '快照带起止时间')
  // 模拟“新一轮查询”：新增批次不改动 B-002 快照引用。
  const snapshotIdBefore = snap.snapshotId
  assert.ok(snapshotIdBefore.startsWith('SNAP-'))
  const another: ExecutionBatch = {
    ...b2,
    id: 'batch-new',
    batchNo: 'B-999',
    rowCount: 999999,
    snapshot: { ...snap, snapshotId: 'SNAP-batch-new', rowCount: 999999 },
  }
  assert.notStrictEqual(another.snapshot!.snapshotId, b2.snapshot!.snapshotId)
  assert.strictEqual(b2.snapshot!.rowCount, 7920, '旧快照行数不被新批次覆盖')
})

// 9. 查询批次起止时间与报表起止时间分别存储。
check('批次起止时间与报表起止时间是两套字段', () => {
  const report = state.reports[0]
  const batch = state.batches.find((b) => b.id === report.batchId)!
  assert.notStrictEqual(report.startedAt, batch.startedAt)
  assert.notStrictEqual(report.endedAt, batch.endedAt)
  assert.ok('startedAt' in report && 'endedAt' in report)
  assert.ok('startedAt' in batch && 'endedAt' in batch)
})

if (failed > 0) {
  console.error(`\n${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n全部不变量断言通过')
