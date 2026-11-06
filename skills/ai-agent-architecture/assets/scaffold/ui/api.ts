// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

/**
 * Thin client over the app's `{ success, data }` envelope. Routes are the canonical table in
 * references/api-surface.md. `baseUrl` includes the prefix: `/api/v1/agent`. Auth is injected per
 * request via `getHeaders`.
 */

import { parseSse } from './sse'
import type {
  Artifact, Attachment, Conversation, ModelOption, Proposal, Ref, SseEvent, Transcript, TurnRequest,
} from './protocol'

type Envelope<T> = {
  success: boolean
  data: T
  pagination?: { hasNext: boolean; nextCursor?: string | null }
  error?: { code: string; message: string }
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export class ApiError extends Error {
  constructor(
    public status: number, // 0 = network failure
    public code: string,
    public retryAfter?: number, // seconds, from Retry-After on 429
  ) {
    super(code)
  }
}

/** Client copy per failure (runs-and-streaming.md §7). Server text is never shown verbatim. */
export function userCopy(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Please try again.'
  switch (e.status) {
    case 0: return 'Connection lost. Check your network and try again.'
    case 401: return 'Your session has expired. Sign in again to continue.'
    case 403: return 'You do not have permission to do that.'
    case 404: return 'That conversation could not be found.'
    case 409: return 'A reply is already in progress.'
    case 413: return 'That file is too large.'
    case 422: return e.code === 'PROPOSAL_STALE'
      ? 'This changed since it was proposed. Ask for a fresh proposal.'
      : 'That could not be done.'
    case 429: return e.retryAfter
      ? `The assistant is busy. Try again in ${e.retryAfter} seconds.`
      : 'The assistant is busy. Try again shortly.'
    case 504: return 'The reply took too long. Try again.'
    default: return 'The assistant is unavailable right now. Try again shortly.'
  }
}

export interface ApiConfig {
  baseUrl: string
  getHeaders: () => Record<string, string> | Promise<Record<string, string>>
}

export function createApi({ baseUrl, getHeaders }: ApiConfig) {
  async function request(method: string, path: string, init: { body?: unknown; form?: FormData; signal?: AbortSignal; accept?: string } = {}) {
    const headers: Record<string, string> = { Accept: init.accept ?? 'application/json', ...(await getHeaders()) }
    let body: BodyInit | undefined
    if (init.form) body = init.form // the browser sets the multipart boundary
    else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    let res: Response
    try {
      res = await fetch(baseUrl + path, { method, headers, body, signal: init.signal })
    } catch (e) {
      if (init.signal?.aborted) throw e
      throw new ApiError(0, 'NETWORK')
    }
    if (!res.ok) {
      const env = (await res.json().catch(() => null)) as Envelope<unknown> | null
      const ra = Number(res.headers.get('Retry-After'))
      throw new ApiError(res.status, env?.error?.code ?? 'UNKNOWN', ra > 0 ? ra : undefined)
    }
    return res
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await request(method, path, { body })
    return res.status === 204 ? ({ success: true, data: undefined as T }) : ((await res.json()) as Envelope<T>)
  }

  async function stream(method: string, path: string, body: unknown, signal: AbortSignal): Promise<AsyncGenerator<SseEvent>> {
    const res = await request(method, path, { body, signal, accept: 'text/event-stream' })
    if (!res.body) throw new ApiError(0, 'NO_STREAM')
    return parseSse(res.body, signal)
  }

  const q = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v))
    const str = s.toString()
    return str ? `?${str}` : ''
  }

  return {
    // conversations
    async listConversations(p: { cursor?: string; q?: string; limit?: number } = {}): Promise<Page<Conversation>> {
      const env = await json<Conversation[]>('GET', `/conversations${q({ limit: 30, ...p })}`)
      return { items: env.data, nextCursor: env.pagination?.hasNext ? (env.pagination.nextCursor ?? null) : null }
    },
    createConversation: async (model?: string) => (await json<Conversation>('POST', '/conversations', { model })).data,
    updateConversation: async (id: string, patch: { title?: string; pinned?: boolean; model?: string; lastFailedTurn?: null }) =>
      (await json<Conversation>('PATCH', `/conversations/${id}`, patch)).data,
    deleteConversation: async (id: string) => void (await json<void>('DELETE', `/conversations/${id}`)),
    /** Cursor-paginated, oldest first (api-surface.md §2): `all` follows every page; false reads the first only (meta fields). */
    async transcript(id: string, all = true): Promise<Transcript> {
      const page = (cursor?: string) => json<Transcript>('GET', `/conversations/${id}/messages${q({ cursor, limit: 100 })}`)
      const first = await page()
      const messages = [...first.data.messages]
      for (let p = first; all && p.pagination?.hasNext && p.pagination.nextCursor; ) {
        p = await page(p.pagination.nextCursor)
        messages.push(...p.data.messages)
      }
      return { ...first.data, messages }
    },

    // runs (runs-and-streaming.md §1-§4)
    sendTurn: (id: string, req: TurnRequest, signal: AbortSignal) => stream('POST', `/conversations/${id}/messages`, req, signal),
    attachRun: (id: string, signal: AbortSignal) => stream('GET', `/conversations/${id}/run`, undefined, signal),
    /** Stop is a user decision; 404 just means no Run in this process (already finished). */
    async stopRun(id: string) {
      try {
        await json<void>('DELETE', `/conversations/${id}/run`)
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e
      }
    },

    // proposals (proposals.md §6-§7)
    listProposals: async (id: string) => (await json<Proposal[]>('GET', `/conversations/${id}/proposals`)).data,
    decideProposal: async (id: string, status: 'accepted' | 'rejected') =>
      (await json<{ proposalId: string; status: string; resultId?: string }>('PATCH', `/proposals/${id}`, { status })).data,
    editProposalLine: async (id: string, lineId: string, value: string) =>
      (await json<Proposal>('PATCH', `/proposals/${id}/lines/${lineId}`, { value })).data,

    // feedback, inputs, extras
    sendFeedback: async (messageId: string, score: 1 | 0 | null, comment?: string) =>
      void (await json<void>('POST', `/messages/${messageId}/feedback`, { score, comment })),
    async uploadAttachment(file: File): Promise<Attachment> {
      const form = new FormData()
      form.append('file', file)
      return ((await (await request('POST', '/attachments', { form })).json()) as Envelope<Attachment>).data
    },
    starters: async (page?: Ref) =>
      (await json<{ prompts: string[] }>('GET', `/starters${q({ pageKind: page?.kind, pageId: page?.id })}`)).data.prompts,
    models: async () => (await json<{ models: ModelOption[] }>('GET', '/models')).data.models,
    /** 204 undone; 409 already undone; 410 window expired (trust.md §4). Callers map those codes. */
    undoAction: async (id: string) => void (await json<void>('POST', `/actions/${id}/undo`)),
    artifact: async (id: string, version?: number) => (await json<Artifact>('GET', `/artifacts/${id}${q({ version })}`)).data,
  }
}

export type Api = ReturnType<typeof createApi>
