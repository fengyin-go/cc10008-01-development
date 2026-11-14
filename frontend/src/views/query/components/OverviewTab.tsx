import { useMemo } from 'react'

import type { ExecutionBatch, QueryStatement } from '../domain/types'
import { dayKey, formatDateTime, formatDuration, STATUS_TONE } from '../domain/format'

type Props = {
  statements: QueryStatement[]
  batches: ExecutionBatch[]
  onOpenBatch: (batch: ExecutionBatch) => void
}

export default function OverviewTab({ statements, batches, onOpenBatch }: Props) {
  const statementMap = useMemo(
    () => new Map(statements.map((item) => [item.id, item])),
    [statements],
  )

  // 概览按时间（开始时间倒序）列出批次，并按日分组。
  const groups = useMemo(() => {
    const sorted = [...batches].sort((a, b) => b.startedAt - a.startedAt)
    const map = new Map<string, ExecutionBatch[]>()
    for (const batch of sorted) {
      const key = dayKey(batch.startedAt)
      const list = map.get(key) ?? []
      list.push(batch)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [batches])

  const running = batches.filter((batch) => batch.status === '执行中').length
  const interrupted = batches.filter((batch) => batch.status === '已中断').length
  const timedOut = batches.filter((batch) => batch.status === '已超时').length
  const stopped = batches.filter((batch) => batch.status === '已终止').length
  const done = batches.filter((batch) => batch.status === '已完成').length

  return (
    <div>
      <div className="stat-row">
        <article className="stat-card"><span className="stat-label">执行中批次</span><strong className="stat-value">{running}</strong></article>
        <article className="stat-card"><span className="stat-label">中断待恢复</span><strong className="stat-value">{interrupted}</strong></article>
        <article className="stat-card"><span className="stat-label">已完成快照</span><strong className="stat-value">{done}</strong></article>
        <article className="stat-card"><span className="stat-label">已超时</span><strong className="stat-value">{timedOut}</strong></article>
        <article className="stat-card"><span className="stat-label">手工终止</span><strong className="stat-value">{stopped}</strong></article>
      </div>

      {groups.length === 0 ? (
        <p className="empty-state">暂无执行批次，先到「查询语句」页登记并执行一条查询。</p>
      ) : (
        groups.map(([day, dayBatches]) => (
          <section key={day} className="day-group">
            <h4 className="day-title">{day}</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>批次编号</th><th>所属语句</th><th>目标数据集</th><th>状态</th>
                  <th>起始时间</th><th>结束时间</th><th>耗时</th><th>返回行数</th><th></th>
                </tr>
              </thead>
              <tbody>
                {dayBatches.map((batch) => {
                  const stmt = statementMap.get(batch.statementId)
                  const staged = batch.status === '执行中' || batch.status === '已中断'
                  return (
                    <tr key={batch.id}>
                      <td>{batch.batchNo}</td>
                      <td>{stmt?.code ?? '—'}</td>
                      <td>{batch.targetDataset}</td>
                      <td><span className={`status-pill ${STATUS_TONE[batch.status] ?? ''}`}>{batch.status}</span></td>
                      <td>{formatDateTime(batch.startedAt)}</td>
                      <td>{formatDateTime(batch.endedAt)}</td>
                      <td>{formatDuration(batch.startedAt, batch.endedAt)}</td>
                      <td>
                        {batch.rowCount}
                        {staged && <span className="snapshot-note">（暂存）</span>}
                      </td>
                      <td><button type="button" className="link" onClick={() => onOpenBatch(batch)}>详情</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  )
}
