import type {
  ExecutionBatch,
  QuerySnapshot,
  QueryStatement,
  ReportReference,
  ScanAttempt,
  ShardBoundary,
  TimeoutDiagnosis,
} from './types'
import type { QueryLabState } from './store'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000

function shard(total: number, scannedCount: number, rowsPerShard: number): ShardBoundary[] {
  return Array.from({ length: total }, (_, index) => {
    const scanned = index < scannedCount
    return {
      index,
      code: `S-${String(index + 1).padStart(2, '0')}`,
      rangeFrom: `key-${String(index * 100).padStart(4, '0')}`,
      rangeTo: `key-${String(index * 100 + 99).padStart(4, '0')}`,
      state: scanned ? '已扫描' : '未扫描',
      rowCount: scanned ? rowsPerShard : 0,
      costMs: scanned ? 800 + ((index * 137) % 700) : null,
    }
  })
}

function attempt(no: number, startedAt: number, endedAt: number | null, reason: ScanAttempt['reason'], scanned: number[]): ScanAttempt {
  return { attemptNo: no, startedAt, endedAt, reason, scannedShards: scanned }
}

function snapshotOf(batch: ExecutionBatch, frozenAt: number, sampleRows: QuerySnapshot['sampleRows']): QuerySnapshot {
  return {
    snapshotId: `SNAP-${batch.id}`,
    batchId: batch.id,
    statementId: batch.statementId,
    batchNo: batch.batchNo,
    targetDataset: batch.targetDataset,
    expression: '',
    returnFields: [],
    rowCount: batch.rowCount,
    sampleRows,
    status: batch.status,
    startedAt: batch.startedAt,
    endedAt: batch.endedAt ?? frozenAt,
    frozenAt,
  }
}

/**
 * 演示数据：覆盖超时诊断、手工终止、断线中断可恢复、0 行已完成、未执行草稿、
 * 归档后重放、跨日重试对应同一语句、报表引用旧快照并保留旧超时原因。
 */
export function buildSeedState(): QueryLabState {
  const now = Date.now()
  const statements: QueryStatement[] = []
  const batches: ExecutionBatch[] = []
  const reports: ReportReference[] = []

  // 语句 1：先超时（B-001），跨日重放成功（B-002，已完成快照被报表引用）。
  const s1: QueryStatement = {
    id: 'stmt-1',
    code: 'QUER-0001',
    expression: 'SELECT region, SUM(amount) FROM orders WHERE dt BETWEEN :start AND :end GROUP BY region',
    targetDataset: 'dwd_orders_detail',
    returnFields: ['region', 'amount', 'order_id', 'dt'],
    orderBy: 'amount DESC',
    pageSize: 200,
    maxRows: 50000,
    timeoutSeconds: 30,
    createdAt: now - 3 * DAY,
    archived: false,
  }
  statements.push(s1)

  const b1Start = now - 3 * DAY + 2 * HOUR
  const b1End = b1Start + 30 * MIN
  const b1Diagnosis: TimeoutDiagnosis = {
    kind: '超时',
    lastScannedShardIndex: 2,
    unfinishedShardCodes: ['S-04', 'S-05', 'S-06'],
    timeoutSeconds: 30,
    elapsedMs: 30 * MIN,
    reason: '全部分片扫描累计耗时超过约定超时 30 秒（演示放大为 30 分钟），S-04 扫描段长时间无响应，查询被引擎判定超时并中止。',
    terminatedBy: null,
    diagnosedAt: b1End,
  }
  const b1: ExecutionBatch = {
    id: 'batch-1',
    statementId: s1.id,
    batchNo: 'B-001',
    status: '已超时',
    startedAt: b1Start,
    endedAt: b1End,
    targetDataset: s1.targetDataset,
    shardCount: 6,
    shards: shard(6, 3, 1240),
    attempts: [
      attempt(1, b1Start, b1End, '首次执行', [0, 1, 2]),
    ],
    rowCount: 3720,
    expectZeroRows: false,
    diagnosis: b1Diagnosis,
    snapshot: null,
  }
  b1.snapshot = {
    ...snapshotOf(b1, b1End, []),
    expression: s1.expression,
    returnFields: s1.returnFields,
  }
  batches.push(b1)

  // 跨日重试：同一条语句的新批次 B-002，编号顺延、不复用 B-001。
  const b2Start = now - 2 * DAY + 1 * HOUR
  const b2End = b2Start + 6 * MIN
  const b2: ExecutionBatch = {
    id: 'batch-2',
    statementId: s1.id,
    batchNo: 'B-002',
    status: '已完成',
    startedAt: b2Start,
    endedAt: b2End,
    targetDataset: s1.targetDataset,
    shardCount: 6,
    shards: shard(6, 6, 1320),
    attempts: [attempt(1, b2Start, b2End, '首次执行', [0, 1, 2, 3, 4, 5])],
    rowCount: 7920,
    expectZeroRows: false,
    diagnosis: null,
    snapshot: null,
  }
  b2.snapshot = {
    ...snapshotOf(b2, b2End, [
      { region: '华东', amount: 268400, order_id: 'OD-10021', dt: '2026-11-11' },
      { region: '华北', amount: 214750, order_id: 'OD-10088', dt: '2026-11-11' },
    ]),
    expression: s1.expression,
    returnFields: s1.returnFields,
  }
  batches.push(b2)

  // 报表引用 B-002 的已完成快照，同时把同语句更早的 B-001 超时诊断存档展示。
  const reportStart = now - 2 * DAY + 3 * HOUR
  reports.push({
    id: 'report-1',
    name: '区域销售日报（11-12 期）',
    snapshotId: b2.snapshot!.snapshotId,
    statementId: s1.id,
    batchId: b2.id,
    startedAt: reportStart,
    endedAt: reportStart + 4 * MIN,
    snapshotBatchNo: 'B-002',
    snapshotRowCount: 7920,
    snapshotTargetDataset: s1.targetDataset,
    historicalDiagnoses: [
      {
        batchNo: 'B-001',
        kind: '超时',
        reason: b1Diagnosis.reason,
        terminatedBy: null,
        diagnosedAt: b1Diagnosis.diagnosedAt,
      },
    ],
  })

  // 语句 2：手工终止批次，保留已扫描分片边界与终止人，可恢复。
  const s2: QueryStatement = {
    id: 'stmt-2',
    code: 'QUER-0002',
    expression: 'SELECT user_id, event FROM user_events WHERE event_time >= :since',
    targetDataset: 'dwd_user_event_log',
    returnFields: ['user_id', 'event', 'event_time'],
    orderBy: 'event_time ASC',
    pageSize: 500,
    maxRows: 200000,
    timeoutSeconds: 60,
    createdAt: now - 1 * DAY,
    archived: false,
  }
  statements.push(s2)
  const b3Start = now - 1 * DAY + 30 * MIN
  const b3End = b3Start + 9 * MIN
  const b3Diagnosis: TimeoutDiagnosis = {
    kind: '手工终止',
    lastScannedShardIndex: 3,
    unfinishedShardCodes: ['S-05', 'S-06', 'S-07', 'S-08'],
    timeoutSeconds: 60,
    elapsedMs: 9 * MIN,
    reason: '值班员在扫描进行中手工终止查询，已保留 S-01 至 S-04 的分片边界，下一次可从 S-05 续扫。',
    terminatedBy: '值班管理员',
    diagnosedAt: b3End,
  }
  const b3: ExecutionBatch = {
    id: 'batch-3',
    statementId: s2.id,
    batchNo: 'B-001',
    status: '已终止',
    startedAt: b3Start,
    endedAt: b3End,
    targetDataset: s2.targetDataset,
    shardCount: 8,
    shards: shard(8, 4, 880),
    attempts: [attempt(1, b3Start, b3End, '首次执行', [0, 1, 2, 3])],
    rowCount: 3520,
    expectZeroRows: false,
    diagnosis: b3Diagnosis,
    snapshot: null,
  }
  b3.snapshot = {
    ...snapshotOf(b3, b3End, []),
    expression: s2.expression,
    returnFields: s2.returnFields,
  }
  batches.push(b3)

  // 语句 3：断线中断，残留未完成扫描段，等待恢复（执行中的扫描在刷新后也归入此态）。
  const s3: QueryStatement = {
    id: 'stmt-3',
    code: 'QUER-0003',
    expression: 'SELECT device_id, metric FROM iot_metrics WHERE topic = :topic',
    targetDataset: 'dwd_iot_metric',
    returnFields: ['device_id', 'metric', 'ts'],
    orderBy: 'ts DESC',
    pageSize: 300,
    maxRows: 80000,
    timeoutSeconds: 45,
    createdAt: now - 5 * HOUR,
    archived: false,
  }
  statements.push(s3)
  const b4Start = now - 40 * MIN
  const b4: ExecutionBatch = {
    id: 'batch-4',
    statementId: s3.id,
    batchNo: 'B-001',
    status: '已中断',
    startedAt: b4Start,
    endedAt: null,
    targetDataset: s3.targetDataset,
    shardCount: 5,
    shards: shard(5, 2, 640),
    attempts: [
      { ...attempt(1, b4Start, b4Start + 7 * MIN, '首次执行', [0, 1]) },
    ],
    rowCount: 1280,
    expectZeroRows: false,
    diagnosis: null,
    snapshot: null,
  }
  batches.push(b4)

  // 语句 4：已完成但 0 行命中，与「尚未执行的草稿」明确区分。
  const s4: QueryStatement = {
    id: 'stmt-4',
    code: 'QUER-0004',
    expression: 'SELECT * FROM refund_orders WHERE refund_status = :status AND dt = :dt',
    targetDataset: 'dwd_refund_order',
    returnFields: ['refund_id', 'refund_status', 'amount'],
    orderBy: 'amount ASC',
    pageSize: 100,
    maxRows: 10000,
    timeoutSeconds: 20,
    createdAt: now - 3 * HOUR,
    archived: false,
  }
  statements.push(s4)
  const b5Start = now - 2 * HOUR
  const b5End = b5Start + 2 * MIN
  const b5: ExecutionBatch = {
    id: 'batch-5',
    statementId: s4.id,
    batchNo: 'B-001',
    status: '已完成',
    startedAt: b5Start,
    endedAt: b5End,
    targetDataset: s4.targetDataset,
    shardCount: 4,
    shards: shard(4, 4, 0),
    attempts: [attempt(1, b5Start, b5End, '首次执行', [0, 1, 2, 3])],
    rowCount: 0,
    expectZeroRows: true,
    diagnosis: null,
    snapshot: null,
  }
  b5.snapshot = {
    ...snapshotOf(b5, b5End, []),
    expression: s4.expression,
    returnFields: s4.returnFields,
  }
  batches.push(b5)

  // 语句 5：尚未执行的草稿——没有任何批次，与 0 行已完成查询形成对照。
  statements.push({
    id: 'stmt-5',
    code: 'QUER-0005',
    expression: 'SELECT campaign_id, clicks, converts FROM marketing_campaign WHERE channel = :channel',
    targetDataset: 'dwd_marketing_campaign',
    returnFields: ['campaign_id', 'clicks', 'converts'],
    orderBy: 'converts DESC',
    pageSize: 50,
    maxRows: 5000,
    timeoutSeconds: 25,
    createdAt: now - 20 * MIN,
    archived: false,
  })

  // 语句 6：已归档，历史批次只读；允许复制表达式产生新语句/新批次，不继承旧行数。
  const s6: QueryStatement = {
    id: 'stmt-6',
    code: 'QUER-0006',
    expression: 'SELECT sku_id, stock_qty FROM inventory_snapshot WHERE warehouse = :wh',
    targetDataset: 'dwd_inventory_snapshot',
    returnFields: ['sku_id', 'stock_qty', 'warehouse'],
    orderBy: 'stock_qty DESC',
    pageSize: 100,
    maxRows: 20000,
    timeoutSeconds: 30,
    createdAt: now - 6 * DAY,
    archived: true,
  }
  statements.push(s6)
  const b6Start = now - 6 * DAY + HOUR
  const b6End = b6Start + 5 * MIN
  const b6: ExecutionBatch = {
    id: 'batch-6',
    statementId: s6.id,
    batchNo: 'B-001',
    status: '已完成',
    startedAt: b6Start,
    endedAt: b6End,
    targetDataset: s6.targetDataset,
    shardCount: 3,
    shards: shard(3, 3, 530),
    attempts: [attempt(1, b6Start, b6End, '首次执行', [0, 1, 2])],
    rowCount: 1590,
    expectZeroRows: false,
    diagnosis: null,
    snapshot: null,
  }
  b6.snapshot = {
    ...snapshotOf(b6, b6End, [
      { sku_id: 'SKU-7781', stock_qty: 320, warehouse: '华东一号仓' },
    ]),
    expression: s6.expression,
    returnFields: s6.returnFields,
  }
  batches.push(b6)

  return { statements, batches, reports, statementSeq: 7 }
}
