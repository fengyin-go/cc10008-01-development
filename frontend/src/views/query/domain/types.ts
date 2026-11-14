/**
 * 查询快照与超时诊断领域模型。
 *
 * 设计约束（与需求逐条对应）：
 * - 一条 QueryStatement（原始查询语句）下挂多个 ExecutionBatch（执行批次），
 *   跨日重试、断线恢复、手工终止后续跑都仍然对应同一条原始语句。
 * - 批次编号 batchNo 在语句内按创建顺序生成（B-001、B-002…），一经写入永不重新编号；
 *   回放/恢复只会新增批次或新增「扫描尝试」，绝不覆盖同编号批次的既有执行状态与诊断。
 * - 批次进入终态（已完成/已超时/已终止）后冻结为 QuerySnapshot，内容不可变；
 *   报告只能引用「已完成」的快照，暂存（执行中/中断/超时/终止）不进入报表选择器。
 */

/** 批次生命周期状态。 */
export type BatchStatus =
  | '执行中' // 引擎正在扫描分片（暂存，不可进报表）
  | '已中断' // 断线/请求被迫终止，可从尚未完成的扫描段恢复（暂存）
  | '已完成' // 全部分片扫描完成，冻结为可引用快照
  | '已超时' // 超过语句约定超时秒数，冻结并保留超时诊断
  | '已终止' // 值班员手工终止，保留已扫描分片边界与终止人

/** 单个扫描分片（扫描段）的状态。 */
export type ShardState = '已扫描' | '未扫描'

/** 一次扫描尝试：一个批次可因断线/终止产生多次尝试，恢复时新增尝试而不覆盖旧尝试。 */
export type ScanAttempt = {
  /** 尝试序号，批次内从 1 开始，只增不改。 */
  attemptNo: number
  /** 本次尝试开始时间（毫秒时间戳）。 */
  startedAt: number
  /** 本次尝试结束时间；仍在扫描时为 null。 */
  endedAt: number | null
  /** 进入本次尝试的原因。 */
  reason: '首次执行' | '断线恢复' | '终止后恢复'
  /** 本次尝试实际扫描的分片序号（0 基）。 */
  scannedShards: number[]
}

/** 分片边界：记录每个扫描段扫描到哪里，断线后据此定位续扫位置。 */
export type ShardBoundary = {
  /** 分片序号，0 基。 */
  index: number
  /** 分片编码，例如 S-01。 */
  code: string
  /** 该分片覆盖的扫描键区间（含目标数据集）。 */
  rangeFrom: string
  rangeTo: string
  state: ShardState
  /** 该分片返回行数，未扫描为 0。 */
  rowCount: number
  /** 该分片扫描耗时（毫秒），未扫描为 null。 */
  costMs: number | null
}

/** 超时/终止诊断：只随终态批次冻结，回放旧语句不会改写这里的内容。 */
export type TimeoutDiagnosis = {
  /** 诊断类型：超时或手工终止；正常完成为 null。 */
  kind: '超时' | '手工终止' | null
  /** 触发时已扫描到的分片序号（0 基），即已扫描边界。 */
  lastScannedShardIndex: number | null
  /** 触发时尚未完成的扫描段编码列表。 */
  unfinishedShardCodes: string[]
  /** 约定超时秒数（超时诊断使用）。 */
  timeoutSeconds: number
  /** 实际累计扫描耗时（毫秒）。 */
  elapsedMs: number
  /** 超时原因 / 终止说明。 */
  reason: string
  /** 手工终止人；超时或无终止人时为 null。 */
  terminatedBy: string | null
  /** 诊断生成时间。 */
  diagnosedAt: number
}

/** 原始查询语句：跨日重试始终对应同一条记录。 */
export type QueryStatement = {
  id: string
  /** 语句编号，例如 QUER-0001。 */
  code: string
  expression: string
  /** 目标数据集，会随每次执行一起写入快照。 */
  targetDataset: string
  /** 返回字段，快照里保留实际使用的字段清单。 */
  returnFields: string[]
  orderBy: string
  pageSize: number
  maxRows: number
  /** 约定超时秒数，引擎据此判定超时。 */
  timeoutSeconds: number
  createdAt: number
  /** 是否归档；归档后允许复制表达式重新执行，但不继承旧结果行数。 */
  archived: boolean
}

/**
 * 执行批次：一条语句的一次执行/回放/恢复载体。
 * batchNo 永不变更；同编号批次的状态只允许沿「未完成分片」向前推进，不被新一轮查询覆盖。
 */
export type ExecutionBatch = {
  id: string
  /** 所属原始语句 id。 */
  statementId: string
  /** 语句内批次编号，例如 B-001；旧快照不重新编号。 */
  batchNo: string
  status: BatchStatus
  /** 批次起始时间（首次执行时间，恢复不重置）。 */
  startedAt: number
  /** 批次终态时间；未结束为 null。 */
  endedAt: number | null
  /** 目标数据集冗余写入批次，保证快照自带目标数据集。 */
  targetDataset: string
  shardCount: number
  shards: ShardBoundary[]
  attempts: ScanAttempt[]
  /** 已扫描分片返回行数累计；未执行的草稿不产生批次，与「返回 0 行的已完成查询」区分。 */
  rowCount: number
  /** 模拟该批次完成后是否 0 行命中（用于演示无返回行查询）。 */
  expectZeroRows: boolean
  /** 终态冻结的超时/终止诊断；未结束为 null。 */
  diagnosis: TimeoutDiagnosis | null
  /** 终态后冻结为不可变快照；未结束为 null。 */
  snapshot: QuerySnapshot | null
}

/** 已冻结的执行快照：报告引用的唯一合法对象，内容不可变。 */
export type QuerySnapshot = {
  snapshotId: string
  batchId: string
  statementId: string
  /** 快照生成时绑定的批次编号，旧快照保持原编号。 */
  batchNo: string
  targetDataset: string
  expression: string
  returnFields: string[]
  /** 表达式实际返回行数；0 行与未执行草稿是两回事。 */
  rowCount: number
  /** 抽样留存的结果行（仅展示前若干行）。 */
  sampleRows: Record<string, string | number>[]
  status: BatchStatus
  /** 批次起止时间原样带入快照。 */
  startedAt: number
  endedAt: number
  /** 冻结时刻。 */
  frozenAt: number
}

/** 报表引用：只能引用已完成快照，并长期保留引用时刻的信息与旧超时原因。 */
export type ReportReference = {
  id: string
  name: string
  /** 被引用的快照 id；选择器只允许选择已完成快照。 */
  snapshotId: string
  statementId: string
  batchId: string
  /** 引用创建（报表）起止时间，与查询批次起止时间分别记录、分别展示。 */
  startedAt: number
  endedAt: number
  /** 引用时快照的只读副本信息（行数、编号、目标数据集），后续重放不影响报表。 */
  snapshotBatchNo: string
  snapshotRowCount: number
  snapshotTargetDataset: string
  /**
   * 引用时刻该语句更早批次的超时/终止诊断只读存档。
   * 报表引用旧快照时，仍展示旧超时原因，且不被新一轮查询改写。
   */
  historicalDiagnoses: Array<{
    batchNo: string
    kind: '超时' | '手工终止'
    reason: string
    terminatedBy: string | null
    diagnosedAt: number
  }>
}

/** 新建语句表单输入。 */
export type StatementDraft = {
  expression: string
  targetDataset: string
  returnFields: string[]
  orderBy: string
  pageSize: number
  maxRows: number
  timeoutSeconds: number
  expectZeroRows: boolean
}
