import { useEffect, useMemo, useRef, useState } from 'react'
import io from 'socket.io-client'

// Бьёмся в тот же origin, который раздаёт SPA (Express:4000)
const API =
  (typeof window !== 'undefined' && window.location.origin) ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:4000'

// устойчивый идентификатор браузера — хранится в localStorage
const CLIENT_ID_KEY = 'chatClientId'
function getClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY)
    if (!id) {
      id = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) + Date.now()
      localStorage.setItem(CLIENT_ID_KEY, id)
    }
    return id
  } catch {
    return 'anon-' + Math.random().toString(36).slice(2)
  }
}

export default function Chat() {
  const [room] = useState('general')
  const [user, setUser] = useState('')
  const [text, setText] = useState('')
  const [msgs, setMsgs] = useState([])
  const [saving, setSaving] = useState(false)
  const endRef = useRef(null)
  const fileInputRef = useRef(null)

  const clientId = useMemo(() => getClientId(), [])

  // один socket на компонент
  const socket = useMemo(
    () =>
      io(API, {
        transports: ['websocket', 'polling'],
        withCredentials: false,
        path: '/socket.io',
      }),
    [API]
  )

  // профиль + подписки
  useEffect(() => {
    const join = () => socket.emit('chat:join', { room, clientId })

    const onProfile = (p) => setUser(p?.name || '')
    const onHistory = (arr = []) => setMsgs(arr)
    const onMsg = (m) => setMsgs((prev) => [...prev, m])
    const onSys = (m) => setMsgs((prev) => [...prev, { ...m, system: true }])

    socket.on('connect', join)
    join()
    socket.on('profile', onProfile)
    socket.on('chat:history', onHistory)
    socket.on('chat:message', onMsg)
    socket.on('chat:system', onSys)

    return () => {
      socket.off('connect', join)
      socket.off('profile', onProfile)
      socket.off('chat:history', onHistory)
      socket.off('chat:message', onMsg)
      socket.off('chat:system', onSys)
    }
  }, [socket, room, clientId])

  // автоскролл
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs])

  function fmt(ts) {
    try { return new Date(ts).toLocaleString() } catch { return '' }
  }

  async function saveName() {
    const n = (user || '').trim()
    if (!n) return
    try {
      setSaving(true)
      socket.emit('profile:updateName', n)
    } finally {
      setTimeout(() => setSaving(false), 300)
    }
  }

  async function onPickFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const fd = new FormData()
      fd.append('file', file)

      // аплоадим на тот же origin
      const r = await fetch(`${API}/upload`, { method: 'POST', body: fd })
      if (!r.ok) {
        const txt = await r.text().catch(() => '')
        alert(`Не удалось загрузить файл\nHTTP ${r.status} ${r.statusText}\n${txt || ''}`.trim())
        return
      }

      // сервер вернёт абсолютный URL (https://.../uploads/xxx.jpg) и type
      const { url, type } = await r.json()
      socket.emit('chat:message', { room, text: url, type })
    } catch (err) {
      console.error('upload error:', err)
      alert('Не удалось загрузить файл')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function send(e) {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    socket.emit('chat:message', { room, text: t })
    setText('')
  }

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui', padding: 16, maxWidth: 820, margin: '0 auto' }}>
      <h1>WS Chat</h1>

      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>API: {API}</div>

      {/* Профиль */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Без имени ..." />
        <button onClick={saveName} disabled={saving || !user.trim()}>
          {saving ? 'Сохраняю...' : 'Сохранить имя'}
        </button>
        <input type="file" accept="image/*,video/*" ref={fileInputRef} onChange={onPickFile} />
      </div>

      {/* Сообщения */}
      <div
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 12,
          height: 420,
          overflowY: 'auto',
          background: '#fafafa',
        }}
      >
        {msgs.map((m, idx) => {
          const raw = (m.content ?? m.text ?? '').trim()
          // если путь относительный (/uploads/..), делаем абсолютный для <img>/<video>
          const urlOut = raw.startsWith('/') ? `${window.location.origin}${raw}` : raw

          const isImage = m.type === 'image' || /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(urlOut)
          const isVideo = m.type === 'video' || /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(urlOut)

          return (
            <div key={`${m.id ?? m.ts}-${idx}`} style={{ marginBottom: 12, opacity: m.system ? 0.7 : 1 }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{fmt(m.ts)}</div>

              {m.system ? (
                <em>🛈 {m.text}</em>
              ) : isImage ? (
                <>
                  <b>{m.user}:</b>
                  <div style={{ marginTop: 6 }}>
                    <div style={{ marginBottom: 6 }}>
                      <a href={urlOut} target="_blank" rel="noreferrer">{urlOut}</a>
                    </div>
                    <img
                      src={urlOut}
                      alt=""
                      style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }}
                      onError={(e) => {
                        e.currentTarget.replaceWith(
                          Object.assign(document.createElement('div'), {
                            innerText: 'Не удалось отобразить изображение',
                            style: 'padding:8px;background:#fee;border:1px solid #fcc;border-radius:6px;',
                          })
                        )
                      }}
                    />
                  </div>
                </>
              ) : isVideo ? (
                <>
                  <b>{m.user}:</b>
                  <div style={{ marginTop: 6 }}>
                    <div style={{ marginBottom: 6 }}>
                      <a href={urlOut} target="_blank" rel="noreferrer">{urlOut}</a>
                    </div>
                    <video src={urlOut} controls style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
                  </div>
                </>
              ) : (
                <>
                  <b>{m.user}:</b>{' '}
                  {/^https?:\/\//i.test(urlOut) || raw.startsWith('/') ? (
                    <a href={urlOut} target="_blank" rel="noreferrer">{urlOut}</a>
                  ) : (
                    <span>{m.content ?? m.text}</span>
                  )}
                </>
              )}
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      {/* Ввод */}
      <form onSubmit={send} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          style={{ flex: 1 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Введите сообщение…"
        />
        <button type="submit">Отправить</button>
      </form>
    </div>
  )
}
