import { useMemo, useState } from 'react'

import type { ExecutionBatch, ReportReference } from '../domain/types'
import { formatDateTime } from '../domain/format'

type Props = {
  batches: ExecutionBatch[]
  reports: ReportReference[]
  onCreate: (input: { name: string; snapshotId: string }) => { ok: boolean; message: string }
}

export default function ReportPanel({ batches, reports, onCreate }: Props) {
  const [name, setName] = useState('')
  const [snapshotId, setSnapshotId] = useState('')
  const [message, setMessage] = useState('')

  // 报表选择器只允许选择「已完成」快照；执行中/中断/超时/终止等暂存结果一律不出现。
  const selectable = useMemo(
    () =>
      batches
        .filter((batch) => batch.status === '已完成' && batch.snapshot)
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    [batches],
  )

  function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    if (!snapshotId) {
      setMessage('请先选择一个已完成快照')
      return
    }
    const result = onCreate({ name, snapshotId })
    setMessage(result.message)
    if (result.ok) {
      setName('')
      setSnapshotId('')
    }
  }

  return (
    <div className="report-panel">
      <section className="detail-section">
        <h4>新建报表引用</h4>
        <p className="page-desc">
          选择器只列出已完成查询的执行快照；暂存结果（执行中 / 已中断 / 已超时 / 已终止）不进入选择器。
        </p>
        <form className="filter-bar" onSubmit={handleCreate}>
          <label className="filter-item">
            <span>报表名称</span>
            <input value={name} placeholder="例如 区域销售日报" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="filter-item grow">
            <span>引用已完成快照</span>
            <select value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)}>
              <option value="">— 请选择已完成快照 —</option>
              {selectable.map((batch) => (
                <option key={batch.id} value={batch.snapshot!.snapshotId}>
                  {batch.batchNo} · {batch.targetDataset} · {batch.rowCount} 行（{batch.status}）
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary">生成引用</button>
        </form>
        {message && <p className="error-text">{message}</p>}
      </section>

      <section className="detail-section">
        <h4>报表引用清单（{reports.length}）— 报表起止时间与查询批次起止时间分列</h4>
        {reports.length === 0 ? (
          <p className="empty-state">暂无报表引用</p>
        ) : (
          <div className="report-stack">
            {reports.map((report) => (
              <article key={report.id} className="report-card">
                <header className="batch-card-head">
                  <strong>{report.name}</strong>
                  <span className="snapshot-note">引用快照 {report.snapshotBatchNo}</span>
                </header>
                <dl className="detail-grid">
                  <div><dt>报表开始时间</dt><dd>{formatDateTime(report.startedAt)}</dd></div>
                  <div><dt>报表结束时间</dt><dd>{formatDateTime(report.endedAt)}</dd></div>
                  <div><dt>目标数据集</dt><dd>{report.snapshotTargetDataset}</dd></div>
                  <div><dt>引用快照行数</dt><dd>{report.snapshotRowCount} 行（引用时固化）</dd></div>
                </dl>
                <div className="report-diag">
                  <h5>随报表保留的历史超时 / 终止诊断（只读）</h5>
                  {report.historicalDiagnoses.length === 0 ? (
                    <p className="empty-state">该语句没有更早的超时或终止诊断。</p>
                  ) : (
                    <ul className="attempt-list">
                      {report.historicalDiagnoses.map((diag) => (
                        <li key={`${report.id}-${diag.batchNo}`}>
                          <span className={`status-pill ${diag.kind === '超时' ? 'tone-timeout' : 'tone-stopped'}`}>
                            {diag.kind}
                          </span>
                          批次 {diag.batchNo}
                          {diag.terminatedBy ? ` · 终止人 ${diag.terminatedBy}` : ''}
                          {' · '}{formatDateTime(diag.diagnosedAt)}
                          <p className="reason-text compact">{diag.reason}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
