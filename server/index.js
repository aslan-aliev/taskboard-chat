// server/index.js
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server as SocketIOServer } from 'socket.io'
import Database from 'better-sqlite3'
import multer from 'multer'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import mime from 'mime-types'

// =============== Paths & ENV =================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')

// каталоги/файлы данных
const DATA_DIR   = process.env.DATA_DIR   || path.join(__dirname, 'data')
const DB_FILE    = process.env.DB_FILE    || path.join(DATA_DIR, 'chat.db')
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads')

// dist фронта
const CLIENT_DIST = path.join(ROOT, 'client', 'dist')

// гарантируем каталоги
fs.mkdirSync(DATA_DIR,   { recursive: true })
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// =============== App & IO ====================
const app = express()
const httpServer = createServer(app)
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
})

// доверяем обратному прокси (Render/Cloud)
app.set('trust proxy', true)

app.use(cors())
app.use(express.json())

// Health/ready
app.get('/healthz', (_req, res) => res.type('text').send('ok'))

// =============== Helpers =====================
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0]
  const host  = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}

// Абсолютизируем только пути, начинающиеся с "/"
function absUrlIfNeeded(s, req) {
  if (!s) return s
  if (/^https?:\/\//i.test(s)) return s         // уже абсолютный URL
  if (s.startsWith('/')) {                       // только путь -> делаем абсолютным
    const base = getBaseUrl(req)
    return `${base}${s}`
  }
  return s                                       // обычный текст не трогаем
}

// =============== DB ==========================
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

// добавим колонку browser (clientId), если её ещё нет
try { db.prepare(`ALTER TABLE users ADD COLUMN browser TEXT`).run() } catch { /* exists */ }

const stmtGetUserByIp       = db.prepare('SELECT * FROM users WHERE ip = ? LIMIT 1')
const stmtGetUserByBrowser  = db.prepare('SELECT * FROM users WHERE browser = ? LIMIT 1')
const stmtInsertUser        = db.prepare('INSERT INTO users (ip, name, browser) VALUES (?, ?, ?)')
const stmtNextUnnamed       = db.prepare(`
  SELECT COALESCE(MAX(CAST(SUBSTR(name, 11) AS INTEGER)), 0) + 1 AS n
  FROM users
  WHERE name LIKE 'Без имени %'
`)
const stmtUpdateName        = db.prepare('UPDATE users SET name = ? WHERE id = ?')

function getOrCreateUser({ ip, browser }) {
  let u = null
  if (browser) u = stmtGetUserByBrowser.get(browser)
  if (!u && ip) u = stmtGetUserByIp.get(ip)

  if (!u) {
    const n = stmtNextUnnamed.get().n
    const name = `Без имени ${n}`
    const info = stmtInsertUser.run(ip || null, name, browser || null)
    u = { id: info.lastInsertRowid, ip, name, browser }
  }
  return u
}

// =============== Uploads =====================
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = mime.extension(file.mimetype) || 'bin'
    cb(null, `${Date.now()}-${uuid()}.${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
})

// Стаатическая раздача загруженных файлов (кэшируем)
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  },
}))

// HTTP аплоад — возвращаем абсолютный URL
app.post('/upload', upload.single('file'), (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'No file' })

  const mt   = file.mimetype || ''
  const type = /^image\//.test(mt) ? 'image' : /^video\//.test(mt) ? 'video' : 'file'
  const rel  = `/uploads/${file.filename}`
  const abs  = `${getBaseUrl(req)}${rel}`

  return res.json({ url: abs, type })
})

// =============== Socket.IO ===================
io.on('connection', (socket) => {
  const ipHdr = socket.handshake.headers['x-forwarded-for']
  const rawIp = (ipHdr ? String(ipHdr).split(',')[0].trim() : socket.handshake.address || '')
  const ip = rawIp.replace(/^::ffff:/, '') || 'unknown'

  // join: приходит clientId из браузера
  socket.on('chat:join', ({ room = 'general', clientId } = {}) => {
    const user = getOrCreateUser({ ip, browser: clientId })
    socket.data.user = user
    socket.join(room)

    // История + нормализация только для путей
    const rows = db.prepare('SELECT * FROM messages ORDER BY ts ASC LIMIT 1000').all()
    const normalized = rows.map(r => ({ ...r, content: absUrlIfNeeded(r.content, socket.request) }))

    socket.emit('profile', { name: user.name, ip, clientId })
    socket.emit('chat:history', normalized)
    socket.to(room).emit('chat:system', { text: `${user.name} присоединился`, ts: Date.now() })
  })

  // смена имени
  socket.on('profile:updateName', (newNameRaw) => {
    const newName = String(newNameRaw || '').trim()
    if (!newName || !socket.data.user) return
    stmtUpdateName.run(newName, socket.data.user.id)
    socket.data.user.name = newName
    socket.emit('profile', { name: newName, ip })
  })

  // сообщение
  socket.on('chat:message', ({ room = 'general', text, type = 'text' } = {}) => {
    if (!socket.data.user) return
    const content = absUrlIfNeeded(String(text ?? ''), socket.request)
    const msg = {
      id: uuid(),
      user: socket.data.user.name,
      type,
      content,
      ts: Date.now(),
    }
    db.prepare('INSERT INTO messages (id, user, type, content, ts) VALUES (@id, @user, @type, @content, @ts)').run(msg)
    io.to(room).emit('chat:message', msg)
  })
})

// =============== Serve frontend (SPA) =========
app.use(express.static(CLIENT_DIST))
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'))
})

// =============== Start ========================
const PORT = Number(process.env.PORT || 4000)
httpServer.listen(PORT, () => {
  console.log(`Server ready on :${PORT}`)
  console.log(`DB_FILE: ${DB_FILE}`)
  console.log(`UPLOAD_DIR: ${UPLOAD_DIR}`)
})
