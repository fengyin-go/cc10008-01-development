import { useState } from 'react'

import type { StatementDraft } from '../domain/types'

type Props = {
  onClose: () => void
  onSubmit: (draft: StatementDraft) => void
}

const EMPTY: StatementDraft = {
  expression: '',
  targetDataset: '',
  returnFields: [],
  orderBy: '',
  pageSize: 200,
  maxRows: 50000,
  timeoutSeconds: 30,
  expectZeroRows: false,
}

export default function StatementForm({ onClose, onSubmit }: Props) {
  const [form, setForm] = useState<StatementDraft>(EMPTY)
  const [fieldsText, setFieldsText] = useState('')
  const [error, setError] = useState('')

  function update<K extends keyof StatementDraft>(key: K, value: StatementDraft[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!form.expression.trim()) {
      setError('查询表达式不能为空')
      return
    }
    if (!form.targetDataset.trim()) {
      setError('目标数据集不能为空')
      return
    }
    const returnFields = fieldsText
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (returnFields.length === 0) {
      setError('至少填写一个返回字段')
      return
    }
    onSubmit({ ...form, returnFields })
    onClose()
  }

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <form className="modal-card" onMouseDown={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <header className="modal-head">
          <h3>登记查询语句（草稿）</h3>
          <button type="button" className="link" onClick={onClose}>关闭</button>
        </header>
        <div className="modal-body">
          <label className="form-item">
            <span>查询表达式 *</span>
            <textarea
              rows={3}
              value={form.expression}
              placeholder="SELECT ... FROM ... WHERE ..."
              onChange={(event) => update('expression', event.target.value)}
            />
          </label>
          <label className="form-item">
            <span>目标数据集 *</span>
            <input
              value={form.targetDataset}
              placeholder="例如 dwd_orders_detail"
              onChange={(event) => update('targetDataset', event.target.value)}
            />
          </label>
          <label className="form-item">
            <span>返回字段（逗号分隔）*</span>
            <input
              value={fieldsText}
              placeholder="region, amount, order_id"
              onChange={(event) => setFieldsText(event.target.value)}
            />
          </label>
          <label className="form-item">
            <span>排序条件</span>
            <input value={form.orderBy} onChange={(event) => update('orderBy', event.target.value)} />
          </label>
          <div className="form-grid">
            <label className="form-item">
              <span>分页大小</span>
              <input
                type="number"
                min={1}
                value={form.pageSize}
                onChange={(event) => update('pageSize', Number(event.target.value))}
              />
            </label>
            <label className="form-item">
              <span>最大行数</span>
              <input
                type="number"
                min={1}
                value={form.maxRows}
                onChange={(event) => update('maxRows', Number(event.target.value))}
              />
            </label>
            <label className="form-item">
              <span>超时秒数</span>
              <input
                type="number"
                min={1}
                value={form.timeoutSeconds}
                onChange={(event) => update('timeoutSeconds', Number(event.target.value))}
              />
            </label>
          </div>
          <label className="form-check">
            <input
              type="checkbox"
              checked={form.expectZeroRows}
              onChange={(event) => update('expectZeroRows', event.target.checked)}
            />
            <span>模拟该查询 0 行命中（用于区分「无返回行」与「未执行草稿」）</span>
          </label>
        </div>
        {error && <p className="error-text">{error}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary">保存为草稿</button>
        </footer>
      </form>
    </div>
  )
}
