import type { ExecutionBatch, QueryStatement } from '../domain/types'
import { formatDateTime, formatDuration, STATUS_TONE } from '../domain/format'

type Props = {
  statement: QueryStatement
  batches: ExecutionBatch[]
  operator: string
  onClose: () => void
  onOpenBatch: (batch: ExecutionBatch) => void
  onStart: (statementId: string, expectZeroRows: boolean) => void
  onResume: (batchId: string) => void
  onTerminate: (batchId: string, operator: string) => void
  onDisconnect: (batchId: string) => void
  onArchive: (statementId: string) => void
  onClone: (statementId: string) => void
}

export default function StatementDetail({
  statement,
  batches,
  operator,
  onClose,
  onOpenBatch,
  onStart,
  onResume,
  onTerminate,
  onDisconnect,
  onArchive,
  onClone,
}: Props) {
  const ordered = [...batches].sort((a, b) => a.startedAt - b.startedAt)

  return (
    <div className="drawer-mask" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <aside className="drawer-card" onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h3>
              {statement.code}
              {statement.archived && <span className="status-pill tone-archived">已归档</span>}
              {ordered.length === 0 && <span className="status-pill tone-draft">未执行草稿</span>}
            </h3>
            <p className="page-desc">同一条原始查询语句；跨日重试、恢复都挂在这里，批次按时间顺序并列展示。</p>
          </div>
          <button type="button" className="link" onClick={onClose}>关闭</button>
        </header>

        <div className="drawer-body">
          <section className="detail-section">
            <h4>语句定义</h4>
            <pre className="expr-block">{statement.expression}</pre>
            <dl className="detail-grid">
              <div><dt>目标数据集</dt><dd>{statement.targetDataset}</dd></div>
              <div><dt>返回字段</dt><dd>{statement.returnFields.join('、')}</dd></div>
              <div><dt>排序条件</dt><dd>{statement.orderBy || '—'}</dd></div>
              <div><dt>分页 / 最大行数</dt><dd>{statement.pageSize} / {statement.maxRows}</dd></div>
              <div><dt>超时秒数</dt><dd>{statement.timeoutSeconds} 秒</dd></div>
              <div><dt>登记时间</dt><dd>{formatDateTime(statement.createdAt)}</dd></div>
            </dl>
          </section>

          <section className="detail-section">
            <div className="section-head">
              <h4>执行批次（{ordered.length}）— 新旧批次并列，编号不复用</h4>
              <div className="head-actions">
                <button type="button" className="btn primary" onClick={() => onStart(statement.id, false)}>
                  新批次执行
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onStart(statement.id, true)}
                  title="演示返回 0 行的已完成查询"
                >
                  模拟 0 行执行
                </button>
              </div>
            </div>

            {ordered.length === 0 ? (
              <p className="empty-state">尚未执行任何批次：这是一条草稿，不会产生结果行数，也不进入报表选择器。</p>
            ) : (
              <div className="batch-stack">
                {ordered.map((batch) => {
                  const scanned = batch.shards.filter((shard) => shard.state === '已扫描').length
                  return (
                    <article key={batch.id} className="batch-card">
                      <header className="batch-card-head">
                        <div>
                          <strong>{batch.batchNo}</strong>
                          <span className={`status-pill ${STATUS_TONE[batch.status] ?? ''}`}>{batch.status}</span>
                          {batch.rowCount === 0 && batch.status === '已完成' && (
                            <span className="status-pill tone-zero">返回 0 行</span>
                          )}
                        </div>
                        <button type="button" className="link" onClick={() => onOpenBatch(batch)}>查看快照与诊断</button>
                      </header>
                      <dl className="batch-meta">
                        <div><dt>起始</dt><dd>{formatDateTime(batch.startedAt)}</dd></div>
                        <div><dt>结束</dt><dd>{formatDateTime(batch.endedAt)}</dd></div>
                        <div><dt>耗时</dt><dd>{formatDuration(batch.startedAt, batch.endedAt)}</dd></div>
                        <div><dt>返回行数</dt><dd>{batch.status === '执行中' || batch.status === '已中断' ? `${batch.rowCount}（暂存）` : batch.rowCount}</dd></div>
                        <div><dt>分片</dt><dd>{scanned}/{batch.shardCount}</dd></div>
                        <div><dt>尝试次数</dt><dd>{batch.attempts.length}</dd></div>
                      </dl>
                      {batch.diagnosis && (
                        <p className="reason-text compact">
                          {batch.diagnosis.kind}：{batch.diagnosis.terminatedBy ? `终止人 ${batch.diagnosis.terminatedBy} · ` : ''}
                          {batch.diagnosis.unfinishedShardCodes.join('、') || '无未完成段'}
                        </p>
                      )}
                      <div className="batch-actions">
                        {batch.status === '执行中' && (
                          <>
                            <button type="button" className="btn" onClick={() => onDisconnect(batch.id)}>模拟断线</button>
                            <button type="button" className="btn danger" onClick={() => onTerminate(batch.id, operator)}>手工终止</button>
                          </>
                        )}
                        {(batch.status === '已中断' || batch.status === '已终止') && (
                          <button type="button" className="btn primary" onClick={() => onResume(batch.id)}>
                            恢复（沿用 {batch.batchNo}）
                          </button>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </div>

        <footer className="drawer-foot">
          <button type="button" className="btn" onClick={() => onClone(statement.id)}>
            复制表达式新建语句（不继承旧行数）
          </button>
          {!statement.archived && (
            <button type="button" className="btn ghost" onClick={() => onArchive(statement.id)}>归档语句</button>
          )}
        </footer>
      </aside>
    </div>
  )
}
