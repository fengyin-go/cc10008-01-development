import type { ExecutionBatch, QueryStatement } from '../domain/types'
import { formatCost, formatDateTime, formatDuration, STATUS_TONE } from '../domain/format'

type Props = {
  batch: ExecutionBatch
  statement: QueryStatement
  operator: string
  onClose: () => void
  onResume: (batchId: string) => void
  onTerminate: (batchId: string, operator: string) => void
  onDisconnect: (batchId: string) => void
}

export default function BatchDetail({
  batch,
  statement,
  operator,
  onClose,
  onResume,
  onTerminate,
  onDisconnect,
}: Props) {
  const scannedCount = batch.shards.filter((shard) => shard.state === '已扫描').length
  const totalCost = batch.shards.reduce((sum, shard) => sum + (shard.costMs ?? 0), 0)
  const snapshot = batch.snapshot

  return (
    <div className="modal-mask large" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h3>
            执行批次 {batch.batchNo}
            <span className={`status-pill ${STATUS_TONE[batch.status] ?? ''}`}>{batch.status}</span>
          </h3>
          <button type="button" className="link" onClick={onClose}>关闭</button>
        </header>

        <div className="modal-body">
          <section className="detail-section">
            <h4>执行耗时与起止时间</h4>
            <dl className="detail-grid">
              <div><dt>起始时间</dt><dd>{formatDateTime(batch.startedAt)}</dd></div>
              <div><dt>结束时间</dt><dd>{formatDateTime(batch.endedAt)}</dd></div>
              <div><dt>累计耗时</dt><dd>{formatDuration(batch.startedAt, batch.endedAt)}</dd></div>
              <div><dt>分片扫描耗时</dt><dd>{formatCost(totalCost)}</dd></div>
              <div><dt>目标数据集</dt><dd>{batch.targetDataset}</dd></div>
              <div><dt>扫描进度</dt><dd>{scannedCount} / {batch.shardCount} 个分片</dd></div>
            </dl>
          </section>

          <section className="detail-section">
            <h4>查询表达式与返回字段（快照口径）</h4>
            <pre className="expr-block">{statement.expression}</pre>
            <p className="field-line">
              返回字段：
              {statement.returnFields.map((field) => (
                <span key={field} className="field-tag">{field}</span>
              ))}
            </p>
          </section>

          <section className="detail-section">
            <h4>已扫描分片边界</h4>
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>分片</th><th>扫描键区间</th><th>状态</th><th>返回行数</th><th>分片耗时</th>
                </tr>
              </thead>
              <tbody>
                {batch.shards.map((shard) => (
                  <tr key={shard.code} className={shard.state === '未扫描' ? 'row-pending' : ''}>
                    <td>{shard.code}</td>
                    <td>{shard.rangeFrom} ~ {shard.rangeTo}</td>
                    <td>{shard.state}</td>
                    <td>{shard.rowCount}</td>
                    <td>{formatCost(shard.costMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="detail-section">
            <h4>扫描尝试（恢复只追加，不覆盖）</h4>
            <ol className="attempt-list">
              {batch.attempts.map((item) => (
                <li key={item.attemptNo}>
                  第 {item.attemptNo} 次 · {item.reason} · {formatDateTime(item.startedAt)}
                  {' → '}{formatDateTime(item.endedAt)} · 扫到分片 [
                  {item.scannedShards.map((index) => `S-${String(index + 1).padStart(2, '0')}`).join(', ') || '无'}]
                </li>
              ))}
            </ol>
          </section>

          {batch.diagnosis && (
            <section className="detail-section diagnosis">
              <h4>超时 / 终止诊断（冻结，不可改写）</h4>
              <dl className="detail-grid">
                <div><dt>诊断类型</dt><dd>{batch.diagnosis.kind}</dd></div>
                <div><dt>终止人</dt><dd>{batch.diagnosis.terminatedBy ?? '—'}</dd></div>
                <div><dt>已扫描边界</dt>
                  <dd>
                    {batch.diagnosis.lastScannedShardIndex == null
                      ? '无'
                      : `S-${String(batch.diagnosis.lastScannedShardIndex + 1).padStart(2, '0')}`}
                  </dd>
                </div>
                <div><dt>未完成扫描段</dt><dd>{batch.diagnosis.unfinishedShardCodes.join('、') || '无'}</dd></div>
                <div><dt>约定超时</dt><dd>{batch.diagnosis.timeoutSeconds} 秒</dd></div>
                <div><dt>实际扫描耗时</dt><dd>{formatCost(batch.diagnosis.elapsedMs)}</dd></div>
                <div><dt>诊断时间</dt><dd>{formatDateTime(batch.diagnosis.diagnosedAt)}</dd></div>
              </dl>
              <p className="reason-text">{batch.diagnosis.reason}</p>
            </section>
          )}

          {snapshot && (
            <section className="detail-section">
              <h4>
                执行快照 {snapshot.snapshotId}
                <span className="snapshot-note">冻结于 {formatDateTime(snapshot.frozenAt)}</span>
              </h4>
              <dl className="detail-grid">
                <div><dt>表达式返回行数</dt><dd><strong>{snapshot.rowCount}</strong> 行</dd></div>
                <div><dt>快照状态</dt><dd>{snapshot.status}</dd></div>
              </dl>
              {snapshot.sampleRows.length > 0 ? (
                <table className="data-table compact">
                  <thead>
                    <tr>
                      {Object.keys(snapshot.sampleRows[0]).map((key) => <th key={key}>{key}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.sampleRows.map((row, index) => (
                      <tr key={index}>
                        {Object.values(row).map((value, cell) => <td key={cell}>{String(value)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="empty-state">该快照表达式返回 0 行（已完成但无命中），与未执行草稿不同。</p>
              )}
            </section>
          )}
        </div>

        <footer className="modal-foot">
          {batch.status === '执行中' && (
            <>
              <button type="button" className="btn" onClick={() => onDisconnect(batch.id)}>
                模拟断线 / 请求被迫终止
              </button>
              <button type="button" className="btn danger" onClick={() => onTerminate(batch.id, operator)}>
                手工终止（保留边界与终止人）
              </button>
            </>
          )}
          {(batch.status === '已中断' || batch.status === '已终止') && (
            <button type="button" className="btn primary" onClick={() => onResume(batch.id)}>
              从未完成扫描段恢复（沿用编号 {batch.batchNo}）
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  )
}
