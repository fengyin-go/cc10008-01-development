/**
 * 查询执行引擎的纯函数内核：不依赖 React 与定时器，便于确定性测试。
 * hook（engine.ts）只负责状态容器、定时器调度与本地持久化，所有状态流转都收敛到这里。
 */
import type {
  BatchStatus,
  ExecutionBatch,
  QueryStatement,
  ReportReference,
  ScanAttempt,
  ShardBoundary,
  StatementDraft,
  TimeoutDiagnosis,
} from './types'

export const SHARD_TICK_MS = 900
export const TIMEOUT_SCALE_MS = 700
export const SAMPLE_ROW_LIMIT = 5
export const DEFAULT_SHARDS = 6

export function uid(prefix: string, randomSeed?: number): string {
  const rand = randomSeed != null
    ? randomSeed.toString(36).padStart(6, '0').slice(0, 6)
    : Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

export function nextBatchNo(existing: ExecutionBatch[]): string {
  const max = existing.reduce((acc, batch) => {
    const matched = /^B-(\d+)$/.exec(batch.batchNo)
    return matched ? Math.max(acc, Number(matched[1])) : acc
  }, 0)
  return `B-${String(max + 1).padStart(3, '0')}`
}

export function buildShards(total: number): ShardBoundary[] {
  return Array.from({ length: total }, (_, index) => ({
    index,
    code: `S-${String(index + 1).padStart(2, '0')}`,
    rangeFrom: `key-${String(index * 100).padStart(4, '0')}`,
    rangeTo: `key-${String(index * 100 + 99).padStart(4, '0')}`,
    state: '未扫描' as const,
    rowCount: 0,
    costMs: null,
  }))
}

function buildSampleRows(statement: QueryStatement, batch: ExecutionBatch) {
  if (batch.expectZeroRows || batch.rowCount === 0) {
    return []
  }
  return Array.from({ length: Math.min(SAMPLE_ROW_LIMIT, batch.rowCount) }, (_, index) => {
    const row: Record<string, string | number> = { _row: index + 1 }
    for (const field of statement.returnFields) {
      row[field] = `${field}-示例${index + 1}`
    }
    return row
  })
}

export function freezeSnapshot(statement: QueryStatement, batch: ExecutionBatch, frozenAt: number) {
  return {
    snapshotId: `SNAP-${batch.id}`,
    batchId: batch.id,
    statementId: statement.id,
    batchNo: batch.batchNo,
    targetDataset: batch.targetDataset,
    expression: statement.expression,
    returnFields: [...statement.returnFields],
    rowCount: batch.rowCount,
    sampleRows: buildSampleRows(statement, batch),
    status: batch.status,
    startedAt: batch.startedAt,
    endedAt: batch.endedAt ?? frozenAt,
    frozenAt,
  }
}

export function unfinishedShards(batch: ExecutionBatch): ShardBoundary[] {
  return batch.shards.filter((shard) => shard.state === '未扫描')
}

/** 刷新/断线后，把残留在「执行中」的批次落到「已中断」，保留分片边界。 */
export function reconcileInterrupted(
  batches: ExecutionBatch[],
  now: number,
): ExecutionBatch[] {
  return batches.map((batch) => {
    if (batch.status !== '执行中') {
      return batch
    }
    const attempts = batch.attempts.map((item, idx) =>
      idx === batch.attempts.length - 1 && item.endedAt === null
        ? { ...item, endedAt: now }
        : item,
    )
    return { ...batch, status: '已中断' as BatchStatus, attempts }
  })
}

export type NewStatementContext = {
  statements: QueryStatement[]
  statementSeq: number
  now: number
}

/** 新建语句（草稿，无批次）。返回新语句与下一序号。 */
export function createStatementRecord(
  ctx: NewStatementContext,
  draft: StatementDraft,
): { statement: QueryStatement; nextSeq: number } {
  const nextSeq = ctx.statementSeq + 1
  const statement: QueryStatement = {
    id: uid('stmt'),
    code: `QUER-${String(nextSeq).padStart(4, '0')}`,
    expression: draft.expression,
    targetDataset: draft.targetDataset,
    returnFields: draft.returnFields,
    orderBy: draft.orderBy,
    pageSize: draft.pageSize,
    maxRows: draft.maxRows,
    timeoutSeconds: draft.timeoutSeconds,
    createdAt: ctx.now,
    archived: false,
  }
  return { statement, nextSeq }
}

/** 复制语句表达式生成全新语句，不继承批次与结果行数。 */
export function cloneStatementRecord(
  ctx: NewStatementContext,
  source: QueryStatement,
): { statement: QueryStatement; nextSeq: number } {
  const nextSeq = ctx.statementSeq + 1
  const statement: QueryStatement = {
    id: uid('stmt'),
    code: `QUER-${String(nextSeq).padStart(4, '0')}`,
    expression: source.expression,
    targetDataset: source.targetDataset,
    returnFields: [...source.returnFields],
    orderBy: source.orderBy,
    pageSize: source.pageSize,
    maxRows: source.maxRows,
    timeoutSeconds: source.timeoutSeconds,
    createdAt: ctx.now,
    archived: false,
  }
  return { statement, nextSeq }
}

/** 创建一个新的执行批次（编号顺延），处于执行中、0 分片已扫描。 */
export function startBatchRecord(
  statement: QueryStatement,
  existing: ExecutionBatch[],
  now: number,
  expectZeroRows: boolean,
): ExecutionBatch {
  return {
    id: uid('batch'),
    statementId: statement.id,
    batchNo: nextBatchNo(existing),
    status: '执行中',
    startedAt: now,
    endedAt: null,
    targetDataset: statement.targetDataset,
    shardCount: DEFAULT_SHARDS,
    shards: buildShards(DEFAULT_SHARDS),
    attempts: [
      { attemptNo: 1, startedAt: now, endedAt: null, reason: '首次执行', scannedShards: [] } satisfies ScanAttempt,
    ],
    rowCount: 0,
    expectZeroRows,
    diagnosis: null,
    snapshot: null,
  }
}

/** 恢复中断/终止批次：沿用编号，追加一次扫描尝试，已扫描分片不动。 */
export function resumeBatchRecord(batch: ExecutionBatch, now: number): ExecutionBatch {
  if (batch.status !== '已中断' && batch.status !== '已终止') {
    return batch
  }
  const reason: ScanAttempt['reason'] = batch.status === '已终止' ? '终止后恢复' : '断线恢复'
  const nextAttempt: ScanAttempt = {
    attemptNo: batch.attempts.length + 1,
    startedAt: now,
    endedAt: null,
    reason,
    scannedShards: [],
  }
  return {
    ...batch,
    status: '执行中',
    endedAt: null,
    attempts: [...batch.attempts, nextAttempt],
  }
}

/** 推进单个分片扫描。若触发超时/完成则返回终态批次，否则返回更新后的执行中批次。 */
export function advanceOneShard(
  batch: ExecutionBatch,
  statement: QueryStatement,
  now: number,
): { batch: ExecutionBatch; event: 'advanced' | 'completed' | 'timeout' } {
  const pending = unfinishedShards(batch)
  const elapsed = batch.shards.reduce((sum, shard) => sum + (shard.costMs ?? 0), 0)
  const budgetMs = statement.timeoutSeconds * TIMEOUT_SCALE_MS

  if (elapsed >= budgetMs && pending.length > 0) {
    return {
      batch: finalizeRecord(batch, statement, '已超时', now, {
        kind: '超时',
        timeoutSeconds: statement.timeoutSeconds,
        reason: `全部分片扫描累计耗时超过约定超时 ${statement.timeoutSeconds} 秒，${pending[0].code} 扫描段未在预算内返回，查询被引擎判定超时并中止。`,
        terminatedBy: null,
      }),
      event: 'timeout',
    }
  }

  if (pending.length === 0) {
    return { batch: finalizeRecord(batch, statement, '已完成', now, null), event: 'completed' }
  }

  const target = pending[0]
  const rowsThisShard = batch.expectZeroRows ? 0 : 300 + ((target.index * 211) % 900)
  const shards = batch.shards.map((shard) =>
    shard.index === target.index
      ? { ...shard, state: '已扫描' as const, rowCount: rowsThisShard, costMs: SHARD_TICK_MS }
      : shard,
  )
  const attempts = batch.attempts.map((item, idx) =>
    idx === batch.attempts.length - 1
      ? { ...item, scannedShards: [...item.scannedShards, target.index] }
      : item,
  )
  return {
    batch: { ...batch, shards, attempts, rowCount: batch.rowCount + rowsThisShard },
    event: 'advanced',
  }
}

type DiagnosisSeed = Omit<
  TimeoutDiagnosis,
  'lastScannedShardIndex' | 'unfinishedShardCodes' | 'elapsedMs' | 'diagnosedAt'
>

/** 终态收口：写结束时间、诊断、冻结快照。 */
export function finalizeRecord(
  batch: ExecutionBatch,
  statement: QueryStatement,
  status: BatchStatus,
  now: number,
  diagnosisSeed: DiagnosisSeed | null,
): ExecutionBatch {
  const unfinished = unfinishedShards(batch).map((shard) => shard.code)
  const scannedIndexes = batch.shards.filter((shard) => shard.state === '已扫描').map((shard) => shard.index)
  const lastScanned = scannedIndexes.length ? scannedIndexes[scannedIndexes.length - 1] : null
  const attempts = batch.attempts.map((item, idx) =>
    idx === batch.attempts.length - 1 && item.endedAt === null
      ? { ...item, endedAt: now }
      : item,
  )
  const diagnosis: TimeoutDiagnosis | null = diagnosisSeed
    ? {
        ...diagnosisSeed,
        lastScannedShardIndex: lastScanned,
        unfinishedShardCodes: unfinished,
        elapsedMs: batch.shards.reduce((sum, shard) => sum + (shard.costMs ?? 0), 0),
        diagnosedAt: now,
      }
    : null
  const settled: ExecutionBatch = { ...batch, status, endedAt: now, attempts, diagnosis }
  settled.snapshot = freezeSnapshot(statement, settled, now)
  return settled
}

/** 手工终止。 */
export function terminateRecord(
  batch: ExecutionBatch,
  statement: QueryStatement,
  now: number,
  operator: string,
): ExecutionBatch {
  if (batch.status !== '执行中') {
    return batch
  }
  return finalizeRecord(batch, statement, '已终止', now, {
    kind: '手工终止',
    timeoutSeconds: statement.timeoutSeconds,
    reason: `值班员 ${operator} 手工终止查询，已保留已扫描分片边界，下一次恢复从未完成扫描段继续。`,
    terminatedBy: operator,
  })
}

/** 模拟断线/请求被迫终止：进入已中断，不冻结快照。 */
export function disconnectRecord(batch: ExecutionBatch, now: number): ExecutionBatch {
  if (batch.status !== '执行中') {
    return batch
  }
  const attempts = batch.attempts.map((item, idx) =>
    idx === batch.attempts.length - 1 && item.endedAt === null
      ? { ...item, endedAt: now }
      : item,
  )
  return { ...batch, status: '已中断', attempts }
}

/** 报表引用校验：只接受已完成快照。 */
export function buildReportReference(
  input: { name: string; snapshotId: string },
  batches: ExecutionBatch[],
  now: number,
): { ok: boolean; message: string; report: ReportReference | null } {
  const target = batches.find((batch) => batch.snapshot?.snapshotId === input.snapshotId)
  if (!target || target.status !== '已完成' || !target.snapshot) {
    return { ok: false, message: '只能引用已完成查询的执行快照，暂存结果不可用于报表', report: null }
  }
  const historicalDiagnoses = batches
    .filter(
      (batch) =>
        batch.statementId === target.statementId &&
        batch.diagnosis?.kind != null &&
        batch.startedAt < target.startedAt,
    )
    .map((batch) => ({
      batchNo: batch.batchNo,
      kind: batch.diagnosis!.kind as '超时' | '手工终止',
      reason: batch.diagnosis!.reason,
      terminatedBy: batch.diagnosis!.terminatedBy,
      diagnosedAt: batch.diagnosis!.diagnosedAt,
    }))
  const report: ReportReference = {
    id: uid('report'),
    name: input.name.trim() || `报表引用-${target.batchNo}`,
    snapshotId: input.snapshotId,
    statementId: target.statementId,
    batchId: target.id,
    startedAt: now,
    endedAt: now + 2 * 60 * 1000,
    snapshotBatchNo: target.batchNo,
    snapshotRowCount: target.snapshot.rowCount,
    snapshotTargetDataset: target.snapshot.targetDataset,
    historicalDiagnoses,
  }
  return { ok: true, message: `报表已引用快照 ${target.batchNo}`, report }
}
