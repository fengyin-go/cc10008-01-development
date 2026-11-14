/**
 * 组件冒烟测试：用 react-dom/server 把 QueryView 完整渲染成 HTML，
 * 验证种子数据下所有 Tab/面板可挂载、关键文案存在，不依赖浏览器 DOM。
 */
import assert from 'node:assert'

import React from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'

import QueryView from '../src/views/query/QueryView'
import { buildSeedState } from '../src/views/query/domain/seed'

// localStorage 垫片：让纯前端存储层在 node 下可运行。
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
}
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: new MemoryStorage(),
}
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage =
  (globalThis as unknown as { window: { localStorage: MemoryStorage } }).window.localStorage

let failed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`)
  }
}

const seed = buildSeedState()
;(globalThis as unknown as { window: { localStorage: MemoryStorage } }).window.localStorage.setItem(
  'interactive-analytics-lab:query-snapshot-lab',
  JSON.stringify(seed),
)

console.log('查询工作台 · 组件 SSR 冒烟渲染')

const html = renderToString(
  React.createElement(
    StaticRouter,
    { location: '/query' },
    React.createElement(QueryView),
  ),
)

check('默认渲染批次概览 Tab', () => {
  assert.ok(html.includes('批次概览'), '应包含概览 Tab')
  assert.ok(html.includes('查询执行快照与超时诊断'))
})

check('概览按时间分组并列出批次编号', () => {
  assert.ok(html.includes('B-001'), '应展示批次 B-001')
  assert.ok(html.includes('B-002'), '应展示批次 B-002')
})

check('状态徽标渲染', () => {
  assert.ok(html.includes('已超时') || html.includes('tone-timeout'))
  assert.ok(html.includes('已完成') || html.includes('tone-done'))
})

check('统计卡片渲染', () => {
  assert.ok(html.includes('已完成快照'))
  assert.ok(html.includes('中断待恢复'))
})

check('三个 Tab 都已注册', () => {
  assert.ok(html.includes('报表引用'))
  assert.ok(html.includes('查询语句与历史快照'))
})

check('页面没有抛出 React 错误占位', () => {
  assert.ok(!html.includes('undefined is not'), '不应出现未定义错误')
  assert.ok(html.length > 2000, `渲染产物过短，疑似未正常渲染（${html.length} 字符）`)
})

if (failed > 0) {
  console.error(`\n${failed} 项冒烟断言失败`)
  process.exit(1)
}
console.log(`\n组件渲染通过（产物 ${html.length} 字符）`)
