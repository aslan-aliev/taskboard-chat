// server/index.js
import express from 'express'
import cors from 'cors'
import { Server } from 'socket.io'
import { createServer } from 'http'
import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import mime from 'mime-types'

// === paths / dirs ===
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')

// Пути к данным и статике из ENV (по умолчанию — как локально)
const DATA_DIR   = process.env.DATA_DIR   || __dirname
const DB_FILE    = process.env.DB_FILE    || path.join(DATA_DIR, 'chat.db')
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads')

// Папка со сборкой фронта
const CLIENT_DIST = path.join(ROOT, 'client', 'dist')

// ==== INIT ====
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

// доверяем обратному прокси (Render/Cloud)
app.set('trust proxy', true)

app.use(express.json())
app.use(cors())

// гарантируем наличие папки для загрузок
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// ===== helpers =====
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0]
  const host  = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}

function absUrlIfNeeded(s, req) {
  if (!s) return s
  if (/^https?:\/\//i.test(s)) return s
  const base = getBaseUrl(req)
  return `${base}${s.startsWith('/') ? '' : '/'}${s}`
}

// ===== DB =====
const db = new Database(DB_FILE)

db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL
)`).run()

db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  name TEXT
)`).run()

const stmtGetUserByIp = db.prepare('SELECT * FROM users WHERE ip = ? LIMIT 1')
const stmtInsertUser  = db.prepare('INSERT INTO users (ip, name) VALUES (?, ?)')
const stmtNextUnnamed = db.prepare(`
  SELECT COALESCE(MAX(CAST(SUBSTR(name, 11) AS INTEGER)), 0) + 1 AS n
  FROM users
  WHERE name LIKE 'Без имени %'
`)
const stmtUpdateName  = db.prepare('UPDATE users SET name = ? WHERE id = ?')

// ===== Multer / uploads =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = mime.extension(file.mimetype) || 'bin'
    cb(null, `${Date.now()}-${uuidv4()}.${ext}`)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
})

// статика для файлов + кэш загружаемых
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders(res, filePath) {
    // адекватные заголовки для кэша
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  }
}))

// аплоад: всегда отдаём АБСОЛЮТНЫЙ url
app.post('/upload', upload.any(), (req, res) => {
  const file = (req.files && req.files[0]) || null
  if (!file) return res.status(400).json({ error: 'No file' })

  const mt   = file.mimetype || ''
  const type = /^image\//.test(mt) ? 'image' : /^video\//.test(mt) ? 'video' : 'file'
  const rel  = `/uploads/${file.filename}`
  const abs  = `${getBaseUrl(req)}${rel}`

  res.json({ url: abs, type })
})

// ===== Socket.io =====
io.on('connection', (socket) => {
  const ipHdr = socket.handshake.headers['x-forwarded-for']
  const rawIp = (ipHdr ? ipHdr.split(',')[0].trim() : socket.handshake.address || '')
  const ip = rawIp.replace(/^::ffff:/, '') || 'unknown'

  let user = stmtGetUserByIp.get(ip)
  if (!user) {
    const n = stmtNextUnnamed.get().n
    const name = `Без имени ${n}`
    const info = stmtInsertUser.run(ip, name)
    user = { id: info.lastInsertRowid, ip, name }
  }
  socket.data.user = user
  socket.emit('profile', { name: user.name, ip })

  socket.on('chat:join', ({ room = 'general' }) => {
    socket.join(room)
    // нормализуем старые сообщения (если когда-то были относительные пути)
    const rows = db.prepare(`SELECT * FROM messages ORDER BY ts ASC LIMIT 1000`).all()
    const normalized = rows.map(r => ({ ...r, content: absUrlIfNeeded(r.content, socket.request) }))
    socket.emit('chat:history', normalized)
    socket.to(room).emit('chat:system', { text: `${socket.data.user.name} присоединился`, ts: Date.now() })
  })

  socket.on('profile:updateName', (newNameRaw) => {
    const newName = String(newNameRaw || '').trim()
    if (!newName) return
    stmtUpdateName.run(newName, socket.data.user.id)
    socket.data.user.name = newName
    socket.emit('profile', { name: newName, ip })
  })

  socket.on('chat:message', ({ room = 'general', text, type = 'text' }) => {
    const contentAbs = absUrlIfNeeded(String(text ?? ''), socket.request)
    const msg = {
      id: uuidv4(),
      user: socket.data.user.name,
      type,
      content: contentAbs,
      ts: Date.now()
    }
    db.prepare(`
      INSERT INTO messages (id, user, type, content, ts)
      VALUES (@id, @user, @type, @content, @ts)
    `).run(msg)
    io.to(room).emit('chat:message', msg)
  })
})

// ===== Serve frontend (SPA) from Express =====
app.use(express.static(CLIENT_DIST))
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'))
})

// ==== START ====
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000
httpServer.listen(PORT, () => {
  console.log(`ALL-IN-ONE on http://localhost:${PORT}`)
})
