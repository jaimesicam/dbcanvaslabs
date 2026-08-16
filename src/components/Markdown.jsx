import { Fragment } from 'react'
import { Icon } from './Icons.jsx'
import { useCopy } from './ui.jsx'

// A deliberately small markdown subset — enough for lab instructions and lecture
// notes, with no parser dependency. Supports paragraphs, `- ` bullets, `**bold**`,
// inline `code`, and fenced code blocks.

const BINARIES = [
  'patronictl', 'systemctl', 'mysql', 'psql', 'valkey-cli', 'mongosh', 'curl', 'etcdctl',
  'pg_basebackup', 'pgbackrest', 'runuser', 'journalctl', 'rm', 'cat', 'grep', 'tail',
  'ss', 'ip', 'ps', 'while', 'for', 'echo', 'redis-cli', 'pt-stalk',
]

/** A command is worth offering a copy button for; a bare identifier is not. */
function isCommand(text) {
  const first = text.trim().split(/\s+/)[0]
  return BINARIES.includes(first) || (text.includes(' ') && /^[a-z_][\w.-]*$/.test(first))
}

function InlineCode({ text }) {
  const [copied, copy] = useCopy()
  if (!isCommand(text)) {
    return (
      <code className="rounded bg-surface2 px-1.5 py-0.5 font-mono text-[0.85em] text-accent">
        {text}
      </code>
    )
  }
  return (
    <button
      onClick={() => copy(text)}
      title="Click to copy"
      className="group inline-flex max-w-full items-baseline gap-1 rounded border border-border/70 bg-surface2 px-1.5 py-0.5 align-baseline font-mono text-[0.85em] text-accent transition hover:border-primary/50 hover:bg-primary/10"
    >
      <span className="break-all text-left">{text}</span>
      <span className={`shrink-0 self-center ${copied ? 'text-success' : 'text-muted group-hover:text-primary'}`}>
        {copied ? <Icon.Check size={11} /> : <Icon.Copy size={11} />}
      </span>
    </button>
  )
}

function CodeBlock({ text }) {
  const [copied, copy] = useCopy()
  return (
    <div className="group relative my-2 overflow-hidden rounded-sm border bg-[#0e1117]">
      <button
        onClick={() => copy(text)}
        title="Copy command"
        className={`absolute right-1.5 top-1.5 z-10 inline-flex items-center gap-1 rounded-sm border px-1.5 py-1 text-[10px] font-medium transition ${
          copied
            ? 'border-success/40 bg-success/15 text-success'
            : 'border-border bg-surface2/80 text-muted opacity-0 hover:text-fg group-hover:opacity-100'
        }`}
      >
        {copied ? <Icon.Check size={11} /> : <Icon.Copy size={11} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      {/* Wrap rather than clip: a command the learner cannot fully read is worse
          than one that takes two lines. */}
      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 pr-14 font-mono text-xs leading-relaxed text-[#e6eaf2]">
        {text}
      </pre>
    </div>
  )
}

/**
 * Splits a line into bold / inline-code / plain runs.
 *
 * Exported because the speech layer needs the *same* decomposition this renders: it
 * concatenates the runs' plain text to build what gets spoken, so a word's position in
 * the utterance lines up with the word span on screen (see src/speech/speakable.js).
 * Two parsers would drift and the highlight would land on the wrong word.
 */
export function parseInline(text) {
  const runs = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[1]) runs.push({ kind: 'code', text: m[1].slice(1, -1) })
    else runs.push({ kind: 'bold', text: m[2].slice(2, -2) })
    last = m.index + m[0].length
  }
  if (last < text.length) runs.push({ kind: 'text', text: text.slice(last) })
  return runs
}

/**
 * Splits the supported markdown subset into blocks: `{type:'p'|'ul'|'code'}`. Shared
 * with the speech layer for the same reason parseInline is.
 */
export function parseBlocks(text) {
  const blocks = []
  let para = []
  let list = []
  let fence = null

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') })
    para = []
  }
  const flushList = () => {
    if (list.length) blocks.push({ type: 'ul', items: list })
    list = []
  }

  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().startsWith('```')) {
      if (fence === null) {
        flushPara()
        flushList()
        fence = []
      } else {
        blocks.push({ type: 'code', text: fence.join('\n') })
        fence = null
      }
      continue
    }
    if (fence !== null) {
      fence.push(raw)
      continue
    }
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    if (/^[-*]\s+/.test(line.trim())) {
      flushPara()
      list.push(line.trim().replace(/^[-*]\s+/, ''))
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  if (fence?.length) blocks.push({ type: 'code', text: fence.join('\n') })

  return blocks
}

/** Renders parseInline's runs. */
function renderInline(text, keyBase) {
  return parseInline(text).map((run, i) => {
    if (run.kind === 'code') return <InlineCode key={`${keyBase}c${i}`} text={run.text} />
    if (run.kind === 'bold')
      return (
        <strong key={`${keyBase}b${i}`} className="font-semibold text-fg">
          {run.text}
        </strong>
      )
    return <Fragment key={`${keyBase}t${i}`}>{run.text}</Fragment>
  })
}

export function Markdown({ text, className = '' }) {
  if (!text) return null
  return (
    <div className={`space-y-2.5 ${className}`}>
      {parseBlocks(text).map((b, i) => {
        if (b.type === 'code') return <CodeBlock key={`f${i}`} text={b.text} />
        if (b.type === 'ul') {
          return (
            <ul key={`u${i}`} className="space-y-1.5 pl-1">
              {b.items.map((li, n) => (
                <li key={n} className="flex gap-2 text-sm leading-relaxed text-muted">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                  <span className="min-w-0">{renderInline(li, `u${i}-${n}`)}</span>
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={`p${i}`} className="text-sm leading-relaxed text-muted">
            {renderInline(b.text, `p${i}`)}
          </p>
        )
      })}
    </div>
  )
}

/**
 * DBCanvas lecture notes are plain prose: a short heading line, a blank line, then
 * paragraphs. Detect those heading lines and typeset them properly instead of
 * dumping the whole thing as pre-wrap text.
 */
export function LectureNotes({ text, className = '' }) {
  if (!text) return null
  const chunks = String(text).split('\n\n').map((c) => c.trim()).filter(Boolean)
  return (
    <div className={`space-y-4 ${className}`}>
      {chunks.map((chunk, i) => {
        const isHeading =
          !chunk.includes('\n') &&
          chunk.length < 70 &&
          !chunk.startsWith('-') &&
          !/[.:;]$/.test(chunk)
        if (isHeading) {
          return (
            <h4 key={i} className="pt-1 text-sm font-semibold text-fg">
              {chunk}
            </h4>
          )
        }
        return <Markdown key={i} text={chunk} />
      })}
    </div>
  )
}
