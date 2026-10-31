type PageViewProperties = {
  path: string
  page: 'catalog' | 'book_detail'
  book_id?: number
}

type AppErrorProperties = {
  error_scope: 'render' | 'data_load' | 'route' | 'network'
  message: string
  path: string | null
}

type TelemetryEvent = {
  event_id: string
  timestamp: string
  session_id: string
  user_id: null
  event_type: 'page_viewed' | 'app_error'
  schema_version: string
  request_id: string
  source: 'frontend'
  context: {
    app_version: string
    page_path: string
    referrer: string | null
    viewport_width: number | null
    os: string | null
    language: string | null
  }
  metadata: {
    sequence: number
    batch_id: string
    sent_at: string
    emitter: string
    locale: string | null
  }
  properties: PageViewProperties | AppErrorProperties
}

const API_URL = import.meta.env.VITE_API_URL ?? '/api'
const QUEUE_KEY = 'estante.telemetry.queue.v1'
const SESSION_KEY = 'estante.telemetry.session.v1'
const SESSION_IDLE_MS = 15 * 60 * 1000
const FLUSH_INTERVAL_MS = 5000
const MAX_BATCH_SIZE = 20
const APP_VERSION = '1.0.0'
const EMITTER = 'estante-telemetry/1.0.0'

let memoryQueue: TelemetryEvent[] = []
let isFlushing = false

function localStorageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function readQueue(): TelemetryEvent[] {
  const storage = localStorageOrNull()
  if (!storage) return memoryQueue
  try {
    const stored = storage.getItem(QUEUE_KEY)
    memoryQueue = stored ? JSON.parse(stored) as TelemetryEvent[] : []
  } catch {
    memoryQueue = []
    storage.removeItem(QUEUE_KEY)
  }
  return memoryQueue
}

function writeQueue(queue: TelemetryEvent[]) {
  memoryQueue = queue
  try {
    localStorageOrNull()?.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    // Keep the in-memory queue when browser storage is unavailable.
  }
}

function getSession() {
  const storage = localStorageOrNull()
  const now = Date.now()
  let session: { session_id: string; last_activity: number; sequence: number } | null = null
  try {
    const stored = storage?.getItem(SESSION_KEY)
    if (stored) session = JSON.parse(stored)
  } catch {
    storage?.removeItem(SESSION_KEY)
  }

  if (!session || now - session.last_activity > SESSION_IDLE_MS) {
    session = { session_id: crypto.randomUUID(), last_activity: now, sequence: 0 }
  }
  session.last_activity = now
  session.sequence += 1
  try {
    storage?.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // Session identifiers still work for this page when storage is unavailable.
  }
  return session
}

function enqueue(eventType: TelemetryEvent['event_type'], properties: TelemetryEvent['properties']) {
  const session = getSession()
  const path = window.location.pathname
  const event: TelemetryEvent = {
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    session_id: session.session_id,
    user_id: null,
    event_type: eventType,
    schema_version: '1.0.0',
    request_id: crypto.randomUUID(),
    source: 'frontend',
    context: {
      app_version: APP_VERSION,
      page_path: path,
      referrer: document.referrer ? document.referrer.slice(0, 300) : null,
      viewport_width: window.innerWidth,
      os: null,
      language: navigator.language.slice(0, 35) || null,
    },
    metadata: {
      sequence: session.sequence,
      batch_id: crypto.randomUUID(),
      sent_at: new Date().toISOString(),
      emitter: EMITTER,
      locale: navigator.language.slice(0, 35) || null,
    },
    properties,
  }
  const queue = readQueue()
  queue.push(event)
  writeQueue(queue)
  if (queue.length >= MAX_BATCH_SIZE) void flushTelemetry()
}

export function trackPageView(path: string, page: PageViewProperties['page'], bookId?: number) {
  enqueue('page_viewed', {
    path,
    page,
    ...(bookId === undefined ? {} : { book_id: bookId }),
  })
}

export function trackAppError(
  errorScope: AppErrorProperties['error_scope'],
  message: string,
  path: string | null = window.location.pathname,
) {
  enqueue('app_error', {
    error_scope: errorScope,
    message: message.slice(0, 500),
    path,
  })
}

export async function flushTelemetry(keepalive = false) {
  if (isFlushing) return
  const queued = readQueue()
  if (queued.length === 0) return

  const batch = queued.slice(0, MAX_BATCH_SIZE)
  const batchId = crypto.randomUUID()
  const requestId = crypto.randomUUID()
  const sentAt = new Date().toISOString()
  const payload = {
    events: batch.map((event) => ({
      ...event,
      request_id: requestId,
      metadata: { ...event.metadata, batch_id: batchId, sent_at: sentAt },
    })),
  }

  isFlushing = true
  try {
    const response = await fetch(`${API_URL}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      body: JSON.stringify(payload),
      keepalive,
    })
    if (!response.ok) return
    const sentIds = new Set(batch.map((event) => event.event_id))
    writeQueue(readQueue().filter((event) => !sentIds.has(event.event_id)))
  } catch {
    // Leave the batch queued so a later flush can retry it.
  } finally {
    isFlushing = false
  }
}

if (typeof window !== 'undefined') {
  window.setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS)
  window.addEventListener('pagehide', () => void flushTelemetry(true))
}