// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * Minimal SSE parser over a fetch ReadableStream (references/runs-and-streaming.md §9: POST +
 * fetch, because EventSource cannot POST or set an Authorization header). Frames are
 * `event: <name>\ndata: <json>\n\n`. Handles frames split across chunks, CRLF, multi-line data,
 * and comment/keep-alive lines. Unknown event names and unparseable data are skipped, so a new
 * server event never breaks an old client. Abort ends the iteration quietly; the caller checks
 * its own signal to tell "aborted" from "ended".
 */

import { SSE_EVENT_NAMES, type SseEvent } from './protocol'

function parseFrame(frame: string): SseEvent | null {
  let event = 'message'
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue
    const i = line.indexOf(':')
    const field = i === -1 ? line : line.slice(0, i)
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (!SSE_EVENT_NAMES.has(event) || data.length === 0) return null
  try {
    // Trust boundary: the server owns this vocabulary (protocol.ts mirrors §4).
    return { event, data: JSON.parse(data.join('\n')) } as SseEvent
  } catch {
    return null
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const onAbort = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener('abort', onAbort)
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const ev = parseFrame(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (ev) yield ev
      }
    }
  } catch (e) {
    if (!signal?.aborted) throw e // a real network failure; abort is not one
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // a cancel() still settling; the stream is already finished with
    }
  }
}
