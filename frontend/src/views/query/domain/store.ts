import type {
  ExecutionBatch,
  QueryStatement,
  ReportReference,
} from './types'

/** 查询工作台独立的本地存储键，与通用模块清单（local-store）互不干扰。 */
const STORAGE_KEY = 'interactive-analytics-lab:query-snapshot-lab'

export type QueryLabState = {
  statements: QueryStatement[]
  batches: ExecutionBatch[]
  reports: ReportReference[]
  /** 语句编号自增游标。 */
  statementSeq: number
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function emptyState(): QueryLabState {
  return { statements: [], batches: [], reports: [], statementSeq: 1 }
}

export function loadState(): QueryLabState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as QueryLabState
    return {
      statements: parsed.statements ?? [],
      batches: parsed.batches ?? [],
      reports: parsed.reports ?? [],
      statementSeq: parsed.statementSeq ?? 1,
    }
  } catch {
    return emptyState()
  }
}

export function persistState(state: QueryLabState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): QueryLabState {
  const fresh = emptyState()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
  return fresh
}

export { clone, STORAGE_KEY }
