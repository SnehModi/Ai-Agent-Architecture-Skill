// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, Paperclip, Square } from 'lucide-react'
import { userCopy } from '../api'
import type { Attachment, MentionHit, SlashCommand } from '../protocol'
import { AttachmentChips } from './AttachmentChips'
import { useShell } from './ShellContext'
import { SuggestionList, findTrigger, useSuggestions, type SuggestionItem } from './Suggestions'

const MAX_FILES = 3 // per message (inputs.md §2); the server enforces the real limit
const MAX_MENTIONS = 5

export interface ComposerProps {
  /** Pluggable `@` search; the server resolves each {kind,id} to its real label (inputs.md §1). Omit to disable `@`. */
  searchMentions?: (query: string) => Promise<MentionHit[]>
  /** Pluggable `/` commands: picking one replaces the input with its template. */
  slashCommands?: SlashCommand[]
}

export function Composer({ searchMentions, slashCommands }: ComposerProps) {
  const { api, run } = useShell()
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [files, setFiles] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [mentions, setMentions] = useState<MentionHit[]>([])
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  const trigger = dismissed ? null : findTrigger(text, caret)
  const sug = useSuggestions(trigger, searchMentions, slashCommands)
  const open = !!trigger && (sug.items.length > 0 || sug.loading || sug.failed)

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px` // autosize up to ~8 lines
  }, [text])

  const pick = (it: SuggestionItem) => {
    if (!trigger) return
    if (it.command) setText(it.command.template)
    else if (it.mention) {
      const insert = `@${it.mention.label} `
      setText(text.slice(0, trigger.start) + insert + text.slice(caret))
      setMentions(ms => (ms.some(m => m.id === it.mention?.id && m.kind === it.mention.kind) ? ms : [...ms, it.mention as MentionHit]))
    }
    setActive(0)
  }

  const submit = () => {
    if (run.running || !text.trim() || uploading) return
    // Send references only; keep mentions whose "@label" is still in the text.
    const refs = mentions.filter(m => text.includes(`@${m.label}`)).slice(0, MAX_MENTIONS).map(({ kind, id }) => ({ kind, id }))
    void run.send(text, { mentions: refs, attachments: files })
    setText(''); setFiles([]); setMentions([])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && sug.items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        return setActive(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length)
      }
      const item = sug.items[active]
      if ((e.key === 'Enter' || e.key === 'Tab') && item) return (e.preventDefault(), pick(item))
    }
    if (open && e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), setDismissed(true)) // closes the popover, not the run
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit())
  }

  const upload = async (list: FileList | null) => {
    const chosen = Array.from(list ?? []).slice(0, MAX_FILES - files.length)
    setUploadErr(null)
    setUploading(n => n + chosen.length)
    for (const f of chosen) {
      try {
        const a = await api.uploadAttachment(f)
        setFiles(prev => [...prev, a])
      } catch (e) {
        setUploadErr(`${f.name}: ${userCopy(e)}`)
      } finally {
        setUploading(n => n - 1)
      }
    }
  }

  return (
    <div className="relative border-t border-neutral-200 p-3 dark:border-neutral-800">
      {open && <SuggestionList items={sug.items} active={active} loading={sug.loading} failed={sug.failed} onPick={pick} />}
      <div className="space-y-2 rounded-xl border border-neutral-300 p-2 dark:border-neutral-700">
        <AttachmentChips items={files} onRemove={id => setFiles(f => f.filter(a => a.id !== id))} />
        {uploading > 0 && <div role="status" aria-label="Uploading" className="h-6 w-32 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800" />}
        {uploadErr && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{uploadErr}</p>}
        <div className="flex items-end gap-2">
          <label className={`cursor-pointer rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${files.length >= MAX_FILES ? 'pointer-events-none opacity-40' : ''}`}>
            <Paperclip className="h-5 w-5" aria-label="Attach files" />
            <input type="file" multiple className="sr-only" onChange={e => (void upload(e.target.files), (e.target.value = ''))} />
          </label>
          <textarea ref={ta} rows={1} value={text} aria-label="Message" placeholder="Message… (@ to mention, / for commands)"
            className="max-h-52 flex-1 resize-none bg-transparent py-1.5 outline-none"
            onChange={e => (setText(e.target.value), setCaret(e.target.selectionStart), setDismissed(false), setActive(0))}
            onSelect={e => setCaret(e.currentTarget.selectionStart)} onKeyDown={onKeyDown} />
          {run.running ? (
            <button type="button" aria-label="Stop" onClick={() => void run.stop()} className="rounded-full bg-neutral-900 p-2 text-white dark:bg-white dark:text-black">
              <Square className="h-4 w-4" aria-hidden />
            </button>
          ) : (
            <button type="button" aria-label="Send" disabled={!text.trim() || uploading > 0} onClick={submit} className="rounded-full bg-blue-600 p-2 text-white disabled:opacity-40">
              <ArrowUp className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
