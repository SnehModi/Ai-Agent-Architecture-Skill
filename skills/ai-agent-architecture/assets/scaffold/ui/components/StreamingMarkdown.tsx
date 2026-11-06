// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { Children, isValidElement, memo, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }, () => undefined)
  return (
    <div className="my-2 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center justify-between bg-neutral-100 px-3 py-1 text-xs text-neutral-500 dark:bg-neutral-800">
        <span>{lang || 'text'}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 hover:text-neutral-900 dark:hover:text-white">
          {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-sm"><code>{code}</code></pre>
    </div>
  )
}

// Raw HTML is dropped (skipHtml). Images are never fetched: model/tool text could point them at a tracking URL.
const components: Components = {
  pre({ children }: { children?: ReactNode }) {
    const child = Children.toArray(children)[0]
    if (!isValidElement(child)) return <pre>{children}</pre>
    const { className, children: inner } = (child as ReactElement<{ className?: string; children?: ReactNode }>).props
    return <CodeBlock code={String(inner ?? '').replace(/\n$/, '')} lang={/language-(\S+)/.exec(className ?? '')?.[1] ?? ''} />
  },
  code: ({ children }) => <code className="rounded bg-neutral-100 px-1 py-0.5 text-[0.9em] dark:bg-neutral-800">{children}</code>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-600 underline dark:text-blue-400">{children}</a>,
  img: ({ alt }) => <span className="text-neutral-500">[image{alt ? `: ${alt}` : ''}]</span>,
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="min-w-full border-collapse text-sm">{children}</table></div>,
  th: ({ children }) => <th className="border border-neutral-300 px-2 py-1 text-left dark:border-neutral-700">{children}</th>,
  td: ({ children }) => <td className="border border-neutral-300 px-2 py-1 dark:border-neutral-700">{children}</td>,
}

/** Memoized so a growing message re-renders only itself, once per animation frame (store.ts). */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 break-words leading-relaxed [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</ReactMarkdown>
    </div>
  )
})
