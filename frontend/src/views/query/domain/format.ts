/** 时间与耗时展示工具，全部基于毫秒时间戳。 */

export function formatDateTime(value: number | null | undefined): string {
  if (value == null) {
    return '—'
  }
  const date = new Date(value)
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

export function formatDuration(start: number, end: number | null | undefined): string {
  if (end == null) {
    return '进行中'
  }
  const ms = Math.max(0, end - start)
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes} 分 ${rest} 秒`
}

export function formatCost(ms: number | null | undefined): string {
  if (ms == null) {
    return '—'
  }
  return `${(ms / 1000).toFixed(2)} 秒`
}

export function dayKey(value: number): string {
  return formatDateTime(value).slice(0, 10)
}

export const STATUS_TONE: Record<string, string> = {
  执行中: 'tone-running',
  已中断: 'tone-interrupted',
  已完成: 'tone-done',
  已超时: 'tone-timeout',
  已终止: 'tone-stopped',
}
