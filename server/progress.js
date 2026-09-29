import express from 'express'
import { HttpError } from './auth.js'
import { now } from './db.js'

export const progressMigration = `
CREATE TABLE progress (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (json_valid(state)),
  updated_at TEXT NOT NULL
);
`

export function createProgress(db) {
  const getState = db.prepare('SELECT state, updated_at FROM progress WHERE user_id = ?')
  const saveState = db.prepare(`
    INSERT INTO progress (user_id, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)

  const router = express.Router()

  router.get('/progress', (req, res) => {
    const row = getState.get(req.user.id)
    res.json({ state: row ? JSON.parse(row.state) : null, updatedAt: row?.updated_at ?? null })
  })

  router.put('/progress', (req, res) => {
    const state = req.body?.state
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new HttpError(400, 'El progreso enviado no es válido.')
    saveState.run(req.user.id, JSON.stringify(state), now())
    res.status(204).end()
  })

  return { router }
}
