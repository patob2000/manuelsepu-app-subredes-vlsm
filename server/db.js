import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

export const now = () => new Date().toISOString()

export function openDatabase(migrations) {
  fs.mkdirSync(config.dataDir, { recursive: true })
  const db = new Database(path.join(config.dataDir, 'app.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  const applied = db.pragma('user_version', { simple: true })
  migrations.slice(applied).forEach((sql, offset) => {
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${applied + offset + 1}`)
    })()
  })
  return db
}
