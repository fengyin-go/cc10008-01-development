import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loadState, persistState, resetState, type QueryLabState } from './store'
import { buildSeedState } from './seed'
import {
  advanceOneShard,
  buildReportReference,
  cloneStatementRecord,
  createStatementRecord,
  disconnectRecord,
  reconcileInterrupted,
  resumeBatchRecord,
  startBatchRecord,
  terminateRecord,
  SHARD_TICK_MS,
} from './engine-core'
import type {
  ExecutionBatch,
  QueryStatement,
  StatementDraft,
} from './types'

export { SHARD_TICK_MS }

function initState(): QueryLabState {
  let state = loadState()
  if (state.statements.length === 0 && state.batches.length === 0) {
    state = buildSeedState()
    persistState(state)
  }
  return { ...state, batches: reconcileInterrupted(state.batches, Date.now()) }
}

export type CreateReportInput = {
  name: string
  snapshotId: string
}

export type QueryEngine = {
  state: QueryLabState
  activeBatchIds: string[]
  createStatement: (draft: StatementDraft) => QueryStatement
  archiveStatement: (statementId: string) => void
  /** 复制已归档（或任意）语句的表达式生成一条全新语句，不继承任何旧批次与结果行数。 */
  cloneAsNewStatement: (statementId: string) => QueryStatement
  startBatch: (statementId: string, expectZeroRows?: boolean) => void
  /** 从尚未完成的扫描段恢复：沿用原批次编号，新增一次扫描尝试。 */
  resumeBatch: (batchId: string) => void
  /** 手工终止：保留已扫描分片边界与终止人，冻结诊断。 */
  terminateBatch: (batchId: string, operator: string) => void
  /** 模拟断线/请求被迫终止：进入已中断，允许从扫描段恢复。 */
  simulateDisconnect: (batchId: string) => void
  createReport: (input: CreateReportInput) => { ok: boolean; message: string }
  resetLab: () => void
}

export function useQueryEngine(): QueryEngine {
  const [state, setState] = useState<QueryLabState>(() => initState())
  const stateRef = useRef(state)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  stateRef.current = state

  const commit = useCallback((updater: (prev: QueryLabState) => QueryLabState) => {
    setState((prev) => {
      const next = updater(prev)
      persistState(next)
      return next
    })
  }, [])

  const clearTimer = useCallback((batchId: string) => {
    const timer = timersRef.current.get(batchId)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(batchId)
    }
  }, [])

  /** 定时器回调：每个 tick 推进一个分片，直到终态。 */
  const advance = useCallback(
    (batchId: string) => {
      const current = stateRef.current.batches.find((item) => item.id === batchId)
      if (!current || current.status !== '执行中') {
        timersRef.current.delete(batchId)
        return
      }
      const statement = stateRef.current.statements.find((item) => item.id === current.statementId)
      if (!statement) {
        timersRef.current.delete(batchId)
        return
      }
      const now = Date.now()
      const result = advanceOneShard(current, statement, now)
      commit((prev) => ({
        ...prev,
        batches: prev.batches.map((item) => (item.id === batchId ? result.batch : item)),
      }))
      if (result.event === 'advanced') {
        timersRef.current.set(batchId, setTimeout(() => advance(batchId), SHARD_TICK_MS))
      } else {
        clearTimer(batchId)
      }
    },
    [clearTimer, commit],
  )

  const schedule = useCallback(
    (batchId: string) => {
      clearTimer(batchId)
      timersRef.current.set(batchId, setTimeout(() => advance(batchId), SHARD_TICK_MS))
    },
    [advance, clearTimer],
  )

  const createStatement = useCallback(
    (draft: StatementDraft): QueryStatement => {
      let created: QueryStatement | null = null
      commit((prev) => {
        const { statement, nextSeq } = createStatementRecord(
          { statements: prev.statements, statementSeq: prev.statementSeq, now: Date.now() },
          draft,
        )
        created = statement
        return { ...prev, statements: [...prev.statements, statement], statementSeq: nextSeq }
      })
      return created!
    },
    [commit],
  )

  const archiveStatement = useCallback(
    (statementId: string) => {
      commit((prev) => ({
        ...prev,
        statements: prev.statements.map((item) =>
          item.id === statementId ? { ...item, archived: true } : item,
        ),
      }))
    },
    [commit],
  )

  const cloneAsNewStatement = useCallback(
    (statementId: string): QueryStatement => {
      const source = stateRef.current.statements.find((item) => item.id === statementId)
      if (!source) {
        throw new Error('未找到要复制的查询语句')
      }
      let created: QueryStatement | null = null
      commit((prev) => {
        const { statement, nextSeq } = cloneStatementRecord(
          { statements: prev.statements, statementSeq: prev.statementSeq, now: Date.now() },
          source,
        )
        created = statement
        return { ...prev, statements: [...prev.statements, statement], statementSeq: nextSeq }
      })
      return created!
    },
    [commit],
  )

  const startBatch = useCallback(
    (statementId: string, expectZeroRows = false) => {
      const statement = stateRef.current.statements.find((item) => item.id === statementId)
      if (!statement) {
        return
      }
      let newBatchId = ''
      commit((prev) => {
        const existing = prev.batches.filter((item) => item.statementId === statementId)
        const batch = startBatchRecord(statement, existing, Date.now(), expectZeroRows)
        newBatchId = batch.id
        return { ...prev, batches: [...prev.batches, batch] }
      })
      schedule(newBatchId)
    },
    [commit, schedule],
  )

  const resumeBatch = useCallback(
    (batchId: string) => {
      const current = stateRef.current.batches.find((item) => item.id === batchId)
      if (!current || (current.status !== '已中断' && current.status !== '已终止')) {
        return
      }
      commit((prev) => ({
        ...prev,
        batches: prev.batches.map((item) =>
          item.id === batchId ? resumeBatchRecord(item, Date.now()) : item,
        ),
      }))
      schedule(batchId)
    },
    [commit, schedule],
  )

  const terminateBatch = useCallback(
    (batchId: string, operator: string) => {
      const current = stateRef.current.batches.find((item) => item.id === batchId)
      if (!current || current.status !== '执行中') {
        return
      }
      const statement = stateRef.current.statements.find((item) => item.id === current.statementId)
      if (!statement) {
        return
      }
      clearTimer(batchId)
      commit((prev) => ({
        ...prev,
        batches: prev.batches.map((item) =>
          item.id === batchId ? terminateRecord(item, statement, Date.now(), operator) : item,
        ),
      }))
    },
    [clearTimer, commit],
  )

  const simulateDisconnect = useCallback(
    (batchId: string) => {
      const current = stateRef.current.batches.find((item) => item.id === batchId)
      if (!current || current.status !== '执行中') {
        return
      }
      clearTimer(batchId)
      commit((prev) => ({
        ...prev,
        batches: prev.batches.map((item) =>
          item.id === batchId ? disconnectRecord(item, Date.now()) : item,
        ),
      }))
    },
    [clearTimer, commit],
  )

  const createReport = useCallback(
    (input: CreateReportInput): { ok: boolean; message: string } => {
      const result = buildReportReference(input, stateRef.current.batches, Date.now())
      if (!result.ok || !result.report) {
        return { ok: false, message: result.message }
      }
      commit((prev) => ({ ...prev, reports: [...prev.reports, result.report!] }))
      return { ok: true, message: result.message }
    },
    [commit],
  )

  const resetLab = useCallback(() => {
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer)
    }
    timersRef.current.clear()
    const fresh = buildSeedState()
    resetState()
    persistState(fresh)
    setState(fresh)
  }, [])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
    }
  }, [])

  const activeBatchIds = useMemo(
    () => state.batches.filter((batch) => batch.status === '执行中').map((batch) => batch.id),
    [state.batches],
  )

  return {
    state,
    activeBatchIds,
    createStatement,
    archiveStatement,
    cloneAsNewStatement,
    startBatch,
    resumeBatch,
    terminateBatch,
    simulateDisconnect,
    createReport,
    resetLab,
  }
}
