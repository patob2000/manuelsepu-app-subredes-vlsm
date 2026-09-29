import crypto from 'node:crypto'
import express from 'express'
import { config, normalizeEmail } from './config.js'
import { now } from './db.js'

export const authMigration = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email <> '' AND email = lower(trim(email))),
  name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
`

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LMS_TIMEOUT_MS = 15_000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 10
const WRONG_CREDENTIALS = 'Email o contraseña incorrectos.'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

function sameSecret(given, expected) {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url, role: user.role }
}

async function postToLms(path, body) {
  if (!config.lmsUrl) throw new HttpError(503, 'La app no tiene configurada la URL de la plataforma (LMS_URL).')
  try {
    const res = await fetch(config.lmsUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LMS_TIMEOUT_MS),
    })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  } catch {
    throw new HttpError(504, 'La plataforma no respondió. Intenta de nuevo en unos segundos.')
  }
}

export function createAuth(db, { onSignIn = () => {} } = {}) {
  const upsertLmsUser = db.prepare(`
    INSERT INTO users (email, name, avatar_url, role, last_login_at)
    VALUES (@email, @name, @avatarUrl, @role, @now)
    ON CONFLICT (email) DO UPDATE SET
      name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE users.name END,
      avatar_url = excluded.avatar_url,
      role = excluded.role,
      last_login_at = excluded.last_login_at
    RETURNING *`)
  const upsertAdmin = db.prepare(`
    INSERT INTO users (email, name, role, last_login_at)
    VALUES (@email, 'Administrador', 'admin', @now)
    ON CONFLICT (email) DO UPDATE SET
      role = 'admin',
      last_login_at = COALESCE(excluded.last_login_at, users.last_login_at)
    RETURNING *`)
  const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
  const findSessionUser = db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?')

  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  if (config.admin) upsertAdmin.get({ email: config.admin.email, now: null })

  const signIn = db.transaction((upsert, params) => {
    const user = upsert.get(params)
    onSignIn(user)
    const token = crypto.randomBytes(32).toString('hex')
    insertSession.run(sha256(token), user.id, Date.now() + SESSION_TTL_MS)
    return { token, user: publicUser(user) }
  })

  function signInFromLms(lmsUser) {
    const email = normalizeEmail(lmsUser?.email)
    if (!email) throw new HttpError(502, 'La plataforma no devolvió un correo válido.')
    const role = email === config.admin?.email || lmsUser.role === 'admin' ? 'admin' : 'student'
    return signIn(upsertLmsUser, {
      email,
      name: String(lmsUser.name ?? '').trim(),
      avatarUrl: lmsUser.avatarUrl || null,
      role,
      now: now(),
    })
  }

  async function exchange(token, lmsApp) {
    if (typeof token !== 'string' || !token) throw new HttpError(400, 'Token inválido.')
    if (!config.appSlugs.length) throw new HttpError(503, 'La app no tiene configurado su slug (APP_SLUG).')
    const appSlug = lmsApp ? config.appSlugs.find(slug => slug === lmsApp) : config.appSlugs[0]
    if (!appSlug) throw new HttpError(401, 'Esta tarjeta de la plataforma no corresponde a esta app.')

    const { status, data } = await postToLms('/api/access/exchange-token', { token, appSlug })
    if (status === 200 && data.user) return signInFromLms(data.user)
    if (status >= 500) throw new HttpError(502, 'La plataforma tuvo un problema al validar tu acceso. Vuelve a entrar desde la tarjeta de la app.')
    throw new HttpError(401, 'Tu acceso venció o ya se usó. Vuelve a entrar desde la tarjeta de la app en la plataforma.')
  }

  async function login(rawEmail, rawPassword) {
    const email = normalizeEmail(rawEmail)
    const password = typeof rawPassword === 'string' ? rawPassword : ''
    if (!email || !password) throw new HttpError(400, 'Email y contraseña son requeridos.')

    if (config.admin && email === config.admin.email) {
      if (!sameSecret(password, config.admin.password)) throw new HttpError(401, WRONG_CREDENTIALS)
      return signIn(upsertAdmin, { email, now: now() })
    }

    const { status, data } = await postToLms('/api/access/login', { email, password })
    if (status === 200 && data.user) return signInFromLms({ ...data.user, email: data.user.email || email })
    if (status === 400 || status === 401) throw new HttpError(401, WRONG_CREDENTIALS)
    if (status === 429) throw new HttpError(429, data.error || 'Cuenta bloqueada temporalmente. Intenta de nuevo en unos minutos.')
    throw new HttpError(502, 'La plataforma no pudo validar el acceso. Intenta de nuevo en unos segundos.')
  }

  // Sin este límite, el login serviría para probar claves del administrador de prueba
  // y, a través del LMS, las de cualquier alumno.
  const failures = new Map()
  function assertLoginAllowed(ip) {
    const entry = failures.get(ip)
    if (entry && entry.resetAt > Date.now() && entry.count >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, 'Demasiados intentos fallidos. Espera unos minutos antes de volver a intentarlo.')
    }
  }
  function recordLoginFailure(ip) {
    const current = Date.now()
    if (failures.size > 5000) for (const [key, entry] of failures) if (entry.resetAt <= current) failures.delete(key)
    const entry = failures.get(ip)
    if (!entry || entry.resetAt <= current) failures.set(ip, { count: 1, resetAt: current + LOGIN_WINDOW_MS })
    else entry.count++
  }

  function bearerToken(req) {
    const header = req.get('authorization') ?? ''
    return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  }

  function requireUser(req, res, next) {
    const token = bearerToken(req)
    const user = token && findSessionUser.get(sha256(token), Date.now())
    if (!user) return res.status(401).json({ error: 'Tu sesión venció. Vuelve a ingresar.' })
    req.user = user
    next()
  }

  const router = express.Router()
  router.get('/config', (req, res) => res.json({ lmsUrl: config.lmsUrl || null }))
  router.post('/sso', async (req, res) => res.json(await exchange(req.body?.token, req.body?.lmsApp)))
  router.post('/login', async (req, res) => {
    assertLoginAllowed(req.ip)
    try {
      res.json(await login(req.body?.email, req.body?.password))
    } catch (error) {
      if (error.status === 401) recordLoginFailure(req.ip)
      throw error
    }
  })
  router.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }))
  router.post('/logout', (req, res) => {
    const token = bearerToken(req)
    if (token) deleteSession.run(sha256(token))
    res.status(204).end()
  })

  return { router, requireUser }
}

export function apiErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error)
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message })
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Los datos enviados son demasiado grandes.' })
  if (error.expose && error.status) return res.status(error.status).json({ error: 'Solicitud inválida.' })
  console.error(error)
  res.status(500).json({ error: 'Error interno. Intenta de nuevo en unos segundos.' })
}
