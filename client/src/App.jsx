import { useEffect, useMemo, useState } from 'react'
import io from 'socket.io-client'
import { DndContext, useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'

const API = 'http://localhost:4000'

// DnD обёртка для колонок
function DroppableColumn({ id, children }) {
  const { isOver, setNodeRef } = useDroppable({ id: `col-${id}` })
  return (
    <div
      ref={setNodeRef}
      style={{
        background: isOver ? '#e5e7eb' : '#f3f4f6',
        padding: 12,
        borderRadius: 8,
        minWidth: 280
      }}
    >
      {children}
    </div>
  )
}

// DnD обёртка для карточек
function DraggableCard({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `card-${id}`
  })
  const style = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    opacity: isDragging ? 0.6 : 1,
    background: 'white',
    borderRadius: 8,
    padding: 8,
    boxShadow: '0 1px 2px rgba(0,0,0,.08)',
    cursor: 'grab'
  }
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      {children}
    </div>
  )
}

export default function App() {
  const [boards, setBoards] = useState([])
  const [activeBoardId, setActiveBoardId] = useState(null)
  const [columns, setColumns] = useState([])
  const [cards, setCards] = useState([])
  const [newColumn, setNewColumn] = useState('')
  const [newCardTitle, setNewCardTitle] = useState('')
  const socket = useMemo(() => io(API, { transports: ['websocket'] }), [])

  // загрузка списка досок
  useEffect(() => {
    fetch(`${API}/api/boards`)
      .then(r => r.json())
      .then(data => {
        setBoards(data)
        if (data[0]) setActiveBoardId(data[0].id)
      })
    return () => socket.disconnect()
  }, [])

  // загрузка активной доски + подписка на сокеты
  useEffect(() => {
    if (!activeBoardId) return

    fetch(`${API}/api/boards/${activeBoardId}`)
      .then(r => r.json())
      .then(({ columns, cards }) => {
        setColumns(columns)
        setCards(cards)
      })

    socket.emit('joinBoard', activeBoardId)

    const onColumnCreated = (col) => {
      if (col.board_id === activeBoardId) {
        setColumns(prev => [...prev, col].sort((a, b) => a.position - b.position))
      }
    }
    const onColumnUpdated = (col) => {
      if (col.board_id !== activeBoardId) return
      setColumns(prev =>
        prev.map(c => (c.id === col.id ? col : c)).sort((a, b) => a.position - b.position)
      )
    }
    const onCardCreated = (card) => {
      if (card.board_id === activeBoardId) {
        setCards(prev => [...prev, card].sort((a, b) => a.position - b.position))
      }
    }
    const onCardUpdated = (card) => {
      if (card.board_id !== activeBoardId) return
      setCards(prev =>
        prev.map(c => (c.id === card.id ? card : c)).sort((a, b) => a.position - b.position)
      )
    }
    const onCardDeleted = ({ id }) => {
      setCards(prev => prev.filter(c => c.id !== id))
    }

    socket.on('column.created', onColumnCreated)
    socket.on('column.updated', onColumnUpdated)
    socket.on('card.created', onCardCreated)
    socket.on('card.updated', onCardUpdated)
    socket.on('card.deleted', onCardDeleted)

    return () => {
      socket.off('column.created', onColumnCreated)
      socket.off('column.updated', onColumnUpdated)
      socket.off('card.created', onCardCreated)
      socket.off('card.updated', onCardUpdated)
      socket.off('card.deleted', onCardDeleted)
    }
  }, [activeBoardId])

  // группировка карточек по колонкам
  const byColumn = useMemo(() => {
    const map = {}
    for (const c of columns) map[c.id] = []
    for (const card of cards) map[card.column_id]?.push(card)
    for (const k in map) map[k].sort((a, b) => a.position - b.position)
    return map
  }, [columns, cards])

  async function addColumn() {
    if (!newColumn.trim()) return
    const r = await fetch(`${API}/api/boards/${activeBoardId}/columns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newColumn })
    })
    if (r.ok) setNewColumn('')
  }

  async function addCard(columnId) {
    if (!newCardTitle.trim()) return
    const r = await fetch(`${API}/api/columns/${columnId}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newCardTitle })
    })
    if (r.ok) setNewCardTitle('')
  }

  // оптимистическое перемещение
  async function moveCard(card, toColumnId) {
    if (card.column_id === toColumnId) return
    const newPos =
      (byColumn[toColumnId]?.[byColumn[toColumnId].length - 1]?.position ?? -1) + 1

    // обновляем локально
    setCards(prev =>
      prev
        .map(c => (c.id === card.id ? { ...c, column_id: toColumnId, position: newPos } : c))
        .sort((a, b) => a.position - b.position)
    )

    // шлём на сервер
    try {
      await fetch(`${API}/api/cards/${card.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_id: toColumnId, position: newPos })
      })
    } catch {
      fetch(`${API}/api/boards/${activeBoardId}`)
        .then(r => r.json())
        .then(({ columns, cards }) => {
          setColumns(columns)
          setCards(cards)
        })
    }
  }

  async function deleteCard(id) {
    await fetch(`${API}/api/cards/${id}`, { method: 'DELETE' })
  }

  // DnD завершение
  function onDragEnd(ev) {
    const { active, over } = ev
    if (!active || !over) return
    if (!active.id?.toString().startsWith('card-')) return
    if (!over.id?.toString().startsWith('col-')) return

    const cardId = active.id.toString().slice(5)
    const toColumnId = over.id.toString().slice(4)
    const card = cards.find(c => c.id === cardId)
    if (!card) return
    moveCard(card, toColumnId)
  }

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui', padding: 16 }}>
      <h1>Realtime Task Board</h1>

      {/* Boards selector */}
      <div style={{ marginBottom: 12 }}>
        <label>Board: </label>
        <select value={activeBoardId ?? ''} onChange={e => setActiveBoardId(e.target.value)}>
          {boards.map(b => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {/* Add column */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          value={newColumn}
          onChange={e => setNewColumn(e.target.value)}
          placeholder="New column title"
        />
        <button onClick={addColumn}>Add Column</button>
      </div>

      <DndContext onDragEnd={onDragEnd}>
        {/* Board columns */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {columns
            .slice()
            .sort((a, b) => a.position - b.position)
            .map(col => (
              <DroppableColumn key={col.id} id={col.id}>
                <h3 style={{ marginTop: 0 }}>{col.title}</h3>

                {/* Add card */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    style={{ flex: 1 }}
                    value={newCardTitle}
                    onChange={e => setNewCardTitle(e.target.value)}
                    placeholder="New card title"
                  />
                  <button onClick={() => addCard(col.id)}>Add</button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(byColumn[col.id] || []).map(card => (
                    <DraggableCard key={card.id} id={card.id}>
                      <div style={{ fontWeight: 600 }}>{card.title}</div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                        {columns
                          .filter(c => c.id !== card.column_id)
                          .map(c => (
                            <button key={c.id} onClick={() => moveCard(card, c.id)}>
                              → {c.title}
                            </button>
                          ))}
                        <button onClick={() => deleteCard(card.id)} style={{ marginLeft: 'auto' }}>
                          🗑️
                        </button>
                      </div>
                    </DraggableCard>
                  ))}
                </div>
              </DroppableColumn>
            ))}
        </div>
      </DndContext>
    </div>
  )
}
