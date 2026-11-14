/**
 * 引擎纯函数内核的确定性生命周期测试：手工驱动「逐分片扫描」，
 * 覆盖完成 / 超时 / 断线恢复 / 手工终止四条路径与快照、编号、暂存隔离等不变量。
 */
import assert from 'node:assert'

import {
  advanceOneShard,
  buildReportReference,
  buildShards,
  cloneStatementRecord,
  createStatementRecord,
  disconnectRecord,
  resumeBatchRecord,
  startBatchRecord,
  terminateRecord,
  SHARD_TICK_MS,
  TIMEOUT_SCALE_MS,
} from '../src/views/query/domain/engine-core'
import type { ExecutionBatch, QueryStatement, StatementDraft } from '../src/views/query/domain/types'

let failed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`)
  }
}

const baseDraft: StatementDraft = {
  expression: 'SELECT a, b FROM t',
  targetDataset: 'ds_demo',
  returnFields: ['a', 'b'],
  orderBy: 'a',
  pageSize: 100,
  maxRows: 1000,
  timeoutSeconds: 30,
  expectZeroRows: false,
}

function makeStatement(overrides: Partial<StatementDraft> = {}, seq = 1): QueryStatement {
  const { statement } = createStatementRecord(
    { statements: [], statementSeq: seq - 1, now: 1_000_000 },
    { ...baseDraft, ...overrides },
  )
  return statement
}

/** 驱动批次扫到终态，逐拍推进并返回最终批次。 */
function runToEnd(batch: ExecutionBatch, statement: QueryStatement, tick = 1): ExecutionBatch {
  let current = batch
  let guard = 0
  let now = current.startedAt + tick
  while (current.status === '执行中' && guard < 100) {
    const result = advanceOneShard(current, statement, now)
    current = result.batch
    now += tick
    guard += 1
  }
  return current
}

console.log('查询引擎内核 · 确定性生命周期')

check('完整扫描 6 个分片后完成并冻结快照', () => {
  const stmt = makeStatement()
  const batch0 = startBatchRecord(stmt, [], 1_000_000, false)
  const done = runToEnd(batch0, stmt)
  assert.strictEqual(done.status, '已完成')
  assert.strictEqual(done.shards.every((s) => s.state === '已扫描'), true)
  assert.strictEqual(done.shards.length, 6)
  assert.ok(done.rowCount > 0, '应有累计返回行数')
  assert.ok(done.snapshot, '终态必须冻结快照')
  assert.strictEqual(done.snapshot!.rowCount, done.rowCount)
  assert.strictEqual(done.snapshot!.targetDataset, 'ds_demo')
  assert.deepStrictEqual(done.snapshot!.returnFields, ['a', 'b'])
  assert.ok(done.endedAt != null && done.endedAt >= done.startedAt)
})

check('0 行批次完成后快照行数为 0，但仍是已完成而非草稿', () => {
  const stmt = makeStatement({ expectZeroRows: true })
  const batch0 = startBatchRecord(stmt, [], 1_000_000, true)
  const done = runToEnd(batch0, stmt)
  assert.strictEqual(done.status, '已完成')
  assert.strictEqual(done.rowCount, 0)
  assert.ok(done.snapshot)
  assert.strictEqual(done.snapshot!.rowCount, 0)
  assert.strictEqual(done.snapshot!.sampleRows.length, 0)
})

check('超时路径：预算耗尽且仍有未扫描分片时收口为已超时并写诊断', () => {
  // 超时秒数取极小值，使预算在第一个分片扫描后即被突破。
  const stmt = makeStatement({ timeoutSeconds: 1 })
  const batch0 = startBatchRecord(stmt, [], 1_000_000, false)
  // 第一拍：扫一个分片（累计 SHARD_TICK_MS）。
  const first = advanceOneShard(batch0, stmt, 1_000_001)
  assert.strictEqual(first.event, 'advanced')
  // 第二拍：预算 = 1 * 700ms，已扫描累计 900ms >= 700ms，且还有未扫描分片 => 超时。
  const second = advanceOneShard(first.batch, stmt, 1_000_002)
  assert.strictEqual(second.event, 'timeout')
  assert.strictEqual(second.batch.status, '已超时')
  assert.ok(second.batch.diagnosis)
  assert.strictEqual(second.batch.diagnosis!.kind, '超时')
  assert.strictEqual(second.batch.diagnosis!.terminatedBy, null)
  assert.ok(second.batch.diagnosis!.unfinishedShardCodes.length > 0)
  assert.ok(second.batch.snapshot, '超时也冻结快照，留存已扫描行数与字段')
})

check('断线后从未完成扫描段恢复：编号不变、尝试追加、边界保留', () => {
  const stmt = makeStatement()
  const batch0 = startBatchRecord(stmt, [], 1_000_000, false)
  // 扫两个分片后断线。
  let b = advanceOneShard(batch0, stmt, 1_000_001).batch
  b = advanceOneShard(b, stmt, 1_000_002).batch
  const disconnected = disconnectRecord(b, 1_000_003)
  assert.strictEqual(disconnected.status, '已中断')
  assert.strictEqual(disconnected.shards.filter((s) => s.state === '已扫描').length, 2)
  const no = disconnected.batchNo
  const resumed = resumeBatchRecord(disconnected, 1_000_004)
  assert.strictEqual(resumed.batchNo, no, '恢复沿用同一批次编号')
  assert.strictEqual(resumed.attempts.length, 2, '应追加第二次扫描尝试')
  assert.strictEqual(resumed.attempts[1].reason, '断线恢复')
  assert.strictEqual(resumed.shards.filter((s) => s.state === '已扫描').length, 2, '已扫描边界不重置')
  // 续跑应从 S-03 开始直至完成。
  const done = runToEnd(resumed, stmt, 1_000_005)
  assert.strictEqual(done.status, '已完成')
  assert.strictEqual(done.shards[2].state, '已扫描')
  assert.strictEqual(done.attempts.length, 2, '尝试次数保持为 2，未额外造批次')
})

check('手工终止保留边界与终止人，终止后恢复沿用编号', () => {
  const stmt = makeStatement()
  const batch0 = startBatchRecord(stmt, [], 1_000_000, false)
  let b = advanceOneShard(batch0, stmt, 1_000_001).batch
  b = advanceOneShard(b, stmt, 1_000_002).batch
  b = advanceOneShard(b, stmt, 1_000_003).batch
  const stopped = terminateRecord(b, stmt, 1_000_004, '值班管理员')
  assert.strictEqual(stopped.status, '已终止')
  assert.strictEqual(stopped.diagnosis!.kind, '手工终止')
  assert.strictEqual(stopped.diagnosis!.terminatedBy, '值班管理员')
  assert.strictEqual(stopped.diagnosis!.lastScannedShardIndex, 2)
  const no = stopped.batchNo
  const resumed = resumeBatchRecord(stopped, 1_000_005)
  assert.strictEqual(resumed.batchNo, no)
  assert.strictEqual(resumed.attempts[resumed.attempts.length - 1].reason, '终止后恢复')
  const done = runToEnd(resumed, stmt, 1_000_006)
  assert.strictEqual(done.status, '已完成')
})

check('同语句多批次编号顺延且互不覆盖', () => {
  const stmt = makeStatement()
  const b1 = startBatchRecord(stmt, [], 1_000_000, false)
  const b1Done = runToEnd(b1, stmt)
  const b2 = startBatchRecord(stmt, [b1Done], 2_000_000, false)
  assert.strictEqual(b1.batchNo, 'B-001')
  assert.strictEqual(b2.batchNo, 'B-002')
  const b2Done = runToEnd(b2, stmt)
  // 旧快照行数不被新批次影响。
  assert.notStrictEqual(b1Done.snapshot!.snapshotId, b2Done.snapshot!.snapshotId)
  assert.strictEqual(b1Done.batchNo, 'B-001', '旧编号不重新编号')
})

check('报表只能引用已完成快照，拒绝超时/终止/中断', () => {
  const stmt = makeStatement({ timeoutSeconds: 1 })
  const timedOut = runToEnd(startBatchRecord(stmt, [], 1_000_000, false), stmt)
  assert.strictEqual(timedOut.status, '已超时')
  const rejected = buildReportReference(
    { name: 'r', snapshotId: timedOut.snapshot!.snapshotId },
    [timedOut],
    3_000_000,
  )
  assert.strictEqual(rejected.ok, false)

  const okStmt = makeStatement({}, 2)
  const done = runToEnd(startBatchRecord(okStmt, [], 1_000_000, false), okStmt)
  const accepted = buildReportReference(
    { name: '日报', snapshotId: done.snapshot!.snapshotId },
    [done],
    3_000_000,
  )
  assert.strictEqual(accepted.ok, true)
  assert.strictEqual(accepted.report!.snapshotRowCount, done.rowCount)
})

check('报表留存同语句更早批次的历史诊断', () => {
  const stmt = makeStatement({ timeoutSeconds: 1 })
  const timedOut = runToEnd(startBatchRecord(stmt, [], 1_000_000, false), stmt)
  // 第二条同语句批次正常完成（编号 B-002）。
  const okStmt: QueryStatement = { ...stmt, timeoutSeconds: 30 }
  const done = runToEnd(startBatchRecord(okStmt, [timedOut], 2_000_000, false), okStmt)
  const result = buildReportReference(
    { name: '日报', snapshotId: done.snapshot!.snapshotId },
    [timedOut, done],
    3_000_000,
  )
  assert.strictEqual(result.report!.historicalDiagnoses.length, 1)
  assert.strictEqual(result.report!.historicalDiagnoses[0].batchNo, 'B-001')
  assert.strictEqual(result.report!.historicalDiagnoses[0].kind, '超时')
})

check('复制归档语句生成新语句，不继承批次与行数', () => {
  const source = makeStatement()
  const cloned = cloneStatementRecord(
    { statements: [source], statementSeq: 1, now: 5_000_000 },
    { ...source, archived: true },
  )
  assert.strictEqual(cloned.statement.code, 'QUER-0002')
  assert.strictEqual(cloned.statement.expression, source.expression)
  assert.strictEqual(cloned.statement.archived, false)
})

check('分片边界结构包含扫描键区间与编码', () => {
  const shards = buildShards(3)
  assert.deepStrictEqual(shards.map((s) => s.code), ['S-01', 'S-02', 'S-03'])
  assert.ok(shards.every((s) => s.rangeFrom.includes('key-') && s.costMs === null))
})

check('超时预算常量与扫描节拍符合演示设定', () => {
  assert.strictEqual(SHARD_TICK_MS, 900)
  assert.strictEqual(TIMEOUT_SCALE_MS, 700)
})

if (failed > 0) {
  console.error(`\n${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n全部生命周期断言通过')
