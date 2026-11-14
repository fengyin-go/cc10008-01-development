import { useState } from 'react'

import { useQueryEngine } from './domain/engine'
import type { ExecutionBatch, QueryStatement, StatementDraft } from './domain/types'
import OverviewTab from './components/OverviewTab'
import StatementsTab from './components/StatementsTab'
import StatementDetail from './components/StatementDetail'
import BatchDetail from './components/BatchDetail'
import ReportPanel from './components/ReportPanel'
import StatementForm from './components/StatementForm'

type TabKey = 'overview' | 'statements' | 'reports'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '批次概览（按时间）' },
  { key: 'statements', label: '查询语句与历史快照' },
  { key: 'reports', label: '报表引用' },
]

export default function QueryView() {
  const engine = useQueryEngine()
  const { state } = engine
  const [tab, setTab] = useState<TabKey>('overview')
  const [showForm, setShowForm] = useState(false)
  const [activeStatementId, setActiveStatementId] = useState<string | null>(null)
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null)
  const [operator] = useState('值班管理员')
  const [notice, setNotice] = useState('')

  const activeStatement: QueryStatement | null =
    state.statements.find((item) => item.id === activeStatementId) ?? null
  const statementBatches = state.batches.filter((batch) => batch.statementId === activeStatementId)
  const activeBatch: ExecutionBatch | null =
    state.batches.find((item) => item.id === activeBatchId) ?? null
  const activeBatchStatement: QueryStatement | null = activeBatch
    ? state.statements.find((item) => item.id === activeBatch.statementId) ?? null
    : null

  function openStatement(statement: QueryStatement) {
    setActiveStatementId(statement.id)
    setNotice('')
  }

  function openBatch(batch: ExecutionBatch) {
    setActiveBatchId(batch.id)
    setNotice('')
  }

  function handleCreate(draft: StatementDraft) {
    const created = engine.createStatement(draft)
    setNotice(`已登记草稿 ${created.code}，尚未执行、不产生结果行数。`)
    setTab('statements')
  }

  function handleStart(statementId: string, expectZeroRows: boolean) {
    engine.startBatch(statementId, expectZeroRows)
    setNotice('已创建新批次并开始扫描；批次编号顺延，旧批次与旧诊断保持不变。')
  }

  function handleClone(statementId: string) {
    const created = engine.cloneAsNewStatement(statementId)
    setNotice(`已复制表达式生成新语句 ${created.code}，不继承旧批次的结果行数。`)
    setActiveStatementId(created.id)
  }

  return (
    <section className="page query-lab" data-module="query">
      <header className="page-head">
        <div>
          <h2>查询执行快照与超时诊断</h2>
          <p className="page-desc">
            为每条查询语句留存带目标数据集的执行快照与超时诊断；报表只引用已完成快照，
            回放与恢复不改写旧编号、旧诊断，新旧批次并列展示。
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => { engine.resetLab(); setNotice('已重置为演示数据。') }}>
            重置演示数据
          </button>
        </div>
      </header>

      <nav className="tab-bar">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`tab-item ${tab === item.key ? 'active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {notice && <p className="inline-notice">{notice}</p>}

      {tab === 'overview' && (
        <OverviewTab
          statements={state.statements}
          batches={state.batches}
          onOpenBatch={openBatch}
        />
      )}

      {tab === 'statements' && (
        <StatementsTab
          statements={state.statements}
          batches={state.batches}
          onCreate={() => setShowForm(true)}
          onOpen={openStatement}
        />
      )}

      {tab === 'reports' && (
        <ReportPanel
          batches={state.batches}
          reports={state.reports}
          onCreate={engine.createReport}
        />
      )}

      {showForm && (
        <StatementForm onClose={() => setShowForm(false)} onSubmit={handleCreate} />
      )}

      {activeStatement && (
        <StatementDetail
          statement={activeStatement}
          batches={statementBatches}
          operator={operator}
          onClose={() => setActiveStatementId(null)}
          onOpenBatch={openBatch}
          onStart={handleStart}
          onResume={(batchId) => { engine.resumeBatch(batchId); setNotice('已从未完成扫描段恢复，沿用原批次编号并新增一次扫描尝试。') }}
          onTerminate={(batchId, who) => { engine.terminateBatch(batchId, who); setNotice(`已由 ${who} 手工终止，分片边界与终止人已保留。`) }}
          onDisconnect={(batchId) => { engine.simulateDisconnect(batchId); setNotice('已模拟断线 / 请求被迫终止，可从尚未完成的扫描段恢复。') }}
          onArchive={(id) => { engine.archiveStatement(id); setNotice('语句已归档；历史批次只读，可复制表达式重新执行。') }}
          onClone={handleClone}
        />
      )}

      {activeBatch && activeBatchStatement && (
        <BatchDetail
          batch={activeBatch}
          statement={activeBatchStatement}
          operator={operator}
          onClose={() => setActiveBatchId(null)}
          onResume={(batchId) => { engine.resumeBatch(batchId); setNotice('已恢复扫描，原诊断与原编号不变。') }}
          onTerminate={(batchId, who) => { engine.terminateBatch(batchId, who); setNotice(`已由 ${who} 终止。`) }}
          onDisconnect={(batchId) => { engine.simulateDisconnect(batchId); setNotice('已模拟断线。') }}
        />
      )}
    </section>
  )
}
