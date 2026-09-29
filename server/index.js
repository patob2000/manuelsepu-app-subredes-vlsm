import path from 'node:path'
import express from 'express'
import { config } from './config.js'
import { openDatabase } from './db.js'
import { apiErrorHandler, authMigration, createAuth } from './auth.js'
import { createProgress, progressMigration } from './progress.js'

const db = openDatabase([authMigration, progressMigration])
const auth = createAuth(db)
const progress = createProgress(db)

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(express.json({ limit: '256kb' }))

app.get('/api/health', (req, res) => res.json({ ok: true }))
app.use('/api', auth.router)
app.use('/api', auth.requireUser, progress.router)
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }))
app.use(express.static(path.join(import.meta.dirname, '..', 'public')))
app.use(apiErrorHandler)

const server = app.listen(config.port, () => {
  console.log(`VLSM Lab escuchando en el puerto ${config.port}`)
  if (!config.lmsUrl || !config.appSlugs.length) console.warn('Faltan LMS_URL o APP_SLUG: solo funcionará el administrador de prueba.')
})

function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
