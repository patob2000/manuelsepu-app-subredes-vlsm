import path from 'node:path'

export const normalizeEmail = value => String(value ?? '').trim().toLowerCase()

const adminEmail = normalizeEmail(process.env.APP_ADMIN_EMAIL)
const adminPassword = process.env.APP_ADMIN_PASSWORD ?? ''

export const config = {
  port: Number(process.env.PORT) || 3000,
  dataDir: path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', 'data')),
  lmsUrl: String(process.env.LMS_URL ?? '').trim().replace(/\/+$/, ''),
  appSlugs: String(process.env.APP_SLUG ?? '').split(',').map(slug => slug.trim()).filter(Boolean),
  admin: adminEmail && adminPassword ? { email: adminEmail, password: adminPassword } : null,
}
