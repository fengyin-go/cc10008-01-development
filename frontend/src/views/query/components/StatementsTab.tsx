import { useMemo, useState } from 'react'

import type { ExecutionBatch, QueryStatement } from '../domain/types'
import { STATUS_TONE } from '../domain/format'

type Props = {
  statements: QueryStatement[]
  batches: ExecutionBatch[]
  onCreate: () => void
  onOpen: (statement: QueryStatement) => void
}

export default function StatementsTab({ statements, batches, onCreate, onOpen }: Props) {
  const [keyword, setKeyword] = useState('')

  const summary = useMemo(() => {
    const map = new Map<string, { count: number; latest: ExecutionBatch | null }>()
    for (const batch of batches) {
      const entry = map.get(batch.statementId) ?? { count: 0, latest: null as ExecutionBatch | null }
      entry.count += 1
      if (!entry.latest || batch.startedAt > entry.latest.startedAt) {
        entry.latest = batch
      }
      map.set(batch.statementId, entry)
    }
    return map
  }, [batches])

  const filtered = statements.filter((item) => {
    const text = keyword.trim()
    if (!text) {
      return true
    }
    return item.code.includes(text) || item.expression.includes(text) || item.targetDataset.includes(text)
  })

  return (
    <div>
      <div className="filter-bar">
        <label className="filter-item grow">
          <span>按语句编号 / 表达式 / 数据集检索</span>
          <input value={keyword} placeholder="输入关键字" onChange={(event) => setKeyword(event.target.value)} />
        </label>
        <button type="button" className="btn primary" onClick={onCreate}>登记查询语句</button>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>语句编号</th><th>查询表达式</th><th>目标数据集</th><th>执行情况</th>
            <th>最近批次</th><th>状态标记</th><th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((stmt) => {
            const info = summary.get(stmt.id)
            const isDraft = !info || info.count === 0
            const latest = info?.latest ?? null
            return (
              <tr key={stmt.id}>
                <td>{stmt.code}</td>
                <td className="expr-cell">{stmt.expression}</td>
                <td>{stmt.targetDataset}</td>
                <td>{isDraft ? '未执行（草稿）' : `${info!.count} 个批次`}</td>
                <td>
                  {latest ? (
                    <>
                      {latest.batchNo}
                      <span className={`status-pill ${STATUS_TONE[latest.status] ?? ''}`}>{latest.status}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {stmt.archived && <span className="status-pill tone-archived">已归档</span>}
                  {isDraft && <span className="status-pill tone-draft">草稿</span>}
                </td>
                <td><button type="button" className="link" onClick={() => onOpen(stmt)}>打开</button></td>
              </tr>
            )
          })}
          {filtered.length === 0 && (
            <tr><td className="empty-state" colSpan={7}>没有匹配的查询语句</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
