/**
 * 插件版本号的唯一来源。
 *
 * 运行时的 `/healthz` 与 release 记录都读 package.json，避免版本号写两处后漂移。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

export const VERSION = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0'
