/**
 * dsh-qwencode 诊断记录：把 provider 自动注册过程写到临时目录，便于排查
 * （只在插件内部使用，不包含任何 token）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = path.join(tmpdir(), 'dsh-qwencode')
const file = path.join(dir, 'provider-sync.json')

/** 追加一条诊断记录（最多保留最近 50 条）。 */
export function recordDiagnostic(entry) {
  try {
    mkdirSync(dir, { recursive: true })
    let history = []
    try {
      const previous = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(previous?.history)) history = previous.history
    } catch {
      history = []
    }
    history.push({ at: new Date().toISOString(), ...entry })
    if (history.length > 50) history = history.slice(-50)
    writeFileSync(file, `${JSON.stringify({ file, updatedAt: new Date().toISOString(), history }, null, 2)}\n`, 'utf8')
  } catch {
    // 诊断写入失败不影响主流程。
  }
}
