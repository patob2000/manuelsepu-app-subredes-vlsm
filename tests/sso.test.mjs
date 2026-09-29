import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const APP_ROOT = path.join(import.meta.dirname, '..')
const SLUG = 'subredes-vlsm'
const STUDENT = { email: 'alumna@correo.com', name: 'Pedro Alumno', avatarUrl: null, role: 'student' }
const STUDENT_PASSWORD = 'clave-del-lms'
const ADMIN = { email: 'admin@cliente.com', password: 'clave-larga-de-prueba-123' }

const issuedTokens = new Map()
const lmsCalls = []
let lms, app, lmsUrl, dataDir

function readBody(req) {
  return new Promise(resolve => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
  })
}

async function fakeLms(req, res) {
  const body = await readBody(req)
  lmsCalls.push({ path: req.url, body })
  const reply = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
  if (req.url === '/api/access/exchange-token') {
    if (!body.token || !body.appSlug) return reply(400, { error: 'Token invalido.' })
    const issued = issuedTokens.get(body.token)
    issuedTokens.delete(body.token)
    if (!issued || issued.slug !== body.appSlug) return reply(401, { error: 'Token invalido, vencido o ya usado.' })
    return reply(200, { user: issued.user })
  }
  if (req.url === '/api/access/login') {
    if (body.email === STUDENT.email && body.password === STUDENT_PASSWORD) return reply(200, { user: STUDENT })
    return reply(401, { error: 'Email o contraseña incorrectos.' })
  }
  reply(404, { error: 'No encontrado' })
}

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function startApp(extraEnv = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: APP_ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, LMS_URL: lmsUrl, APP_SLUG: SLUG, ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('escuchando')) resolve() })
    child.on('exit', code => reject(new Error(`El servidor terminó con código ${code}`)))
  })
  return { child, base: `http://127.0.0.1:${port}` }
}

async function stopApp() {
  const exited = new Promise(resolve => app.child.on('exit', resolve))
  app.child.kill()
  await exited
}

async function api(route, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(app.base + '/api' + route, { method, headers, body: body && JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, data: text ? JSON.parse(text) : null }
}

function issueToken(user = STUDENT, slug = SLUG) {
  const token = `token-${Math.random().toString(16).slice(2)}`
  issuedTokens.set(token, { slug, user })
  return token
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subredes-vlsm-'))
  lms = http.createServer(fakeLms)
  await new Promise(resolve => lms.listen(0, '127.0.0.1', resolve))
  lmsUrl = `http://127.0.0.1:${lms.address().port}`
  app = await startApp({ APP_ADMIN_EMAIL: ADMIN.email, APP_ADMIN_PASSWORD: ADMIN.password })
})

after(async () => {
  await stopApp()
  lms.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('la tarjeta del LMS abre la sesión del alumno y el token es de un solo uso', async () => {
  const token = issueToken({ ...STUDENT, email: '  Alumna@Correo.com ' })
  const first = await api('/sso', { method: 'POST', body: { token, lmsApp: SLUG } })
  assert.equal(first.status, 200)
  assert.equal(first.data.user.email, STUDENT.email)
  assert.equal(first.data.user.role, 'student')
  assert.deepEqual(lmsCalls.at(-1).body, { token, appSlug: SLUG })

  const reused = await api('/sso', { method: 'POST', body: { token, lmsApp: SLUG } })
  assert.equal(reused.status, 401)
})

test('una tarjeta de otra app no se canjea', async () => {
  const res = await api('/sso', { method: 'POST', body: { token: issueToken(), lmsApp: 'otra-app' } })
  assert.equal(res.status, 401)
})

test('el login con correo y contraseña valida contra el LMS', async () => {
  const ok = await api('/login', { method: 'POST', body: { email: ' ALUMNA@correo.com', password: STUDENT_PASSWORD } })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.user.email, STUDENT.email)

  const wrong = await api('/login', { method: 'POST', body: { email: STUDENT.email, password: 'otra' } })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.data.error, 'Email o contraseña incorrectos.')
})

test('no existen rutas de registro ni de recuperación de contraseña', async () => {
  for (const route of ['/register', '/signup', '/recover', '/forgot-password']) {
    assert.equal((await api(route, { method: 'POST', body: { email: STUDENT.email } })).status, 401)
  }
})

test('el administrador de prueba entra sin consultar al LMS', async () => {
  const callsBefore = lmsCalls.length
  const ok = await api('/login', { method: 'POST', body: { email: ADMIN.email.toUpperCase(), password: ADMIN.password } })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.user.role, 'admin')
  const wrong = await api('/login', { method: 'POST', body: { email: ADMIN.email, password: 'clave-larga-de-prueba-124' } })
  assert.equal(wrong.status, 401)
  assert.equal(lmsCalls.length, callsBefore)
})

test('la misma persona ve el mismo progreso por las dos puertas', async () => {
  const byPassword = (await api('/login', { method: 'POST', body: { email: STUDENT.email, password: STUDENT_PASSWORD } })).data.token
  assert.equal((await api('/progress', { token: byPassword })).data.state, null)
  const state = { level: 3, exercise: 2, done: { L0E0: true }, errors: { Broadcast: 2 }, labDone: { A: true } }
  assert.equal((await api('/progress', { method: 'PUT', token: byPassword, body: { state } })).status, 204)

  const bySso = (await api('/sso', { method: 'POST', body: { token: issueToken() } })).data.token
  assert.deepEqual((await api('/progress', { token: bySso })).data.state, state)
})

test('el administrador encuentra lo que dejó al volver a entrar desde el LMS', async () => {
  const local = (await api('/login', { method: 'POST', body: { email: ADMIN.email, password: ADMIN.password } })).data.token
  await api('/progress', { method: 'PUT', token: local, body: { state: { level: 5, exercise: 0, done: {}, errors: {}, labDone: {} } } })
  const sso = await api('/sso', { method: 'POST', body: { token: issueToken({ ...STUDENT, email: ADMIN.email, name: 'Ana Admin' }) } })
  assert.equal(sso.data.user.role, 'admin')
  assert.equal((await api('/progress', { token: sso.data.token })).data.state.level, 5)
})

test('el progreso inválido se rechaza y sin sesión no hay acceso', async () => {
  const token = (await api('/sso', { method: 'POST', body: { token: issueToken() } })).data.token
  assert.equal((await api('/progress', { method: 'PUT', token, body: { state: [1, 2] } })).status, 400)
  assert.equal((await api('/progress')).status, 401)
  assert.equal((await api('/logout', { method: 'POST', token })).status, 204)
  assert.equal((await api('/me', { token })).status, 401)
})

test('el servidor solo publica la interfaz, no su código ni la base', async () => {
  assert.equal((await fetch(app.base + '/')).status, 200)
  for (const route of ['/package.json', '/server/auth.js', '/data/app.db', '/.env']) {
    assert.equal((await fetch(app.base + route)).status, 404, route)
  }
})

test('tras reiniciar, los datos siguen ahí y sin variables de admin ya no hay administrador local', async () => {
  await stopApp()
  app = await startApp({ APP_ADMIN_EMAIL: '', APP_ADMIN_PASSWORD: '' })
  const token = (await api('/login', { method: 'POST', body: { email: STUDENT.email, password: STUDENT_PASSWORD } })).data.token
  assert.equal((await api('/progress', { token })).data.state.level, 3)
  const admin = await api('/login', { method: 'POST', body: { email: ADMIN.email, password: ADMIN.password } })
  assert.equal(admin.status, 401)
})
