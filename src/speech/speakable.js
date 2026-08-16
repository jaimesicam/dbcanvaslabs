import { parseBlocks, parseInline } from '../components/Markdown.jsx'

/**
 * Turns lab content into the blocks the speech layer speaks and highlights.
 *
 * One block is one utterance. That is deliberate: `speechSynthesis` reports word
 * boundaries as a character offset into the *utterance* it is currently speaking, so
 * short utterances keep the mapping from "character N" back to "that word on screen"
 * trivial, and they give the browser natural pauses between paragraphs and bullets.
 *
 * A block carries the same `runs` the renderer draws (see parseInline), and its spoken
 * text is exactly their concatenation — which is what makes the highlight land on the
 * right word rather than drifting a few characters per inline-code span.
 *
 * Fenced code blocks are dropped, not read. "backtick kubectl space get space nodes" is
 * noise, and the learner is looking at the command anyway; skipping it whole keeps the
 * spoken text and the visible text aligned block-for-block.
 */

function blockFromRuns(runs) {
  return { runs, text: runs.map((r) => r.text).join('') }
}

/** A block of literal prose — no markdown parsing (lab.description, a title). */
export function textBlock(text) {
  const t = String(text || '').trim()
  return t ? blockFromRuns([{ kind: 'text', text: t }]) : null
}

/** A heading-ish lead-in the renderer shows in its own style. */
export function headingBlock(text) {
  const t = String(text || '').trim()
  return t ? { ...blockFromRuns([{ kind: 'text', text: t }]), heading: true } : null
}

/** Markdown → blocks. Paragraphs stay whole; each bullet becomes its own block. */
export function markdownBlocks(md) {
  if (!md) return []
  const out = []
  for (const b of parseBlocks(md)) {
    if (b.type === 'code') continue
    if (b.type === 'ul') {
      for (const item of b.items) out.push({ ...blockFromRuns(parseInline(item)), bullet: true })
      continue
    }
    out.push(blockFromRuns(parseInline(b.text)))
  }
  return out
}

/**
 * Lecture notes → blocks, using the same heading heuristic LectureNotes renders with
 * (a short, single-line, unpunctuated chunk is a heading).
 */
export function lectureBlocks(text) {
  if (!text) return []
  const out = []
  for (const chunk of String(text).split('\n\n').map((c) => c.trim()).filter(Boolean)) {
    const isHeading = !chunk.includes('\n') && chunk.length < 70 && !chunk.startsWith('-') && !/[.:;]$/.test(chunk)
    if (isHeading) {
      const h = headingBlock(chunk)
      if (h) out.push(h)
    } else {
      out.push(...markdownBlocks(chunk))
    }
  }
  return out
}

/** Drops the nulls textBlock/headingBlock return for empty input. */
export function compact(blocks) {
  return blocks.filter(Boolean)
}

/**
 * The word boundaries of a block's spoken text, as [start, end) character ranges.
 *
 * These are deliberately computed on the *whole block*, never per run: a word can
 * straddle a run boundary — an inline-code path followed by the sentence's full stop is
 * one word to the synthesizer but two runs on screen — and splitting per run would leave
 * half of such a word unhighlighted. Renderers slice their runs against these ranges so
 * every fragment of a word knows which word it belongs to.
 */
export function wordRanges(text) {
  const ranges = []
  const re = /\S+/g
  let m
  while ((m = re.exec(text))) ranges.push([m.index, m.index + m[0].length])
  return ranges
}

/** Index of the word containing `charIndex`, or -1. */
export function wordAt(ranges, charIndex) {
  if (charIndex < 0) return -1
  for (let i = 0; i < ranges.length; i++) {
    if (charIndex >= ranges[i][0] && charIndex < ranges[i][1]) return i
  }
  return -1
}

/**
 * Cuts one run into the pieces the renderer draws, each tagged with the index of the
 * word it belongs to (or -1 for the whitespace between words).
 */
export function runSegments(run, base, ranges) {
  const segments = []
  const end = base + run.text.length
  const at = (from, to, word) => {
    if (to > from) segments.push({ text: run.text.slice(from - base, to - base), word })
  }

  let pos = base
  let i = 0
  while (i < ranges.length && ranges[i][1] <= base) i++

  while (pos < end) {
    if (i >= ranges.length || ranges[i][0] >= end) {
      at(pos, end, -1)
      break
    }
    if (pos < ranges[i][0]) {
      at(pos, Math.min(ranges[i][0], end), -1)
      pos = Math.min(ranges[i][0], end)
      continue
    }
    const stop = Math.min(ranges[i][1], end)
    at(pos, stop, i)
    pos = stop
    if (ranges[i][1] <= end) i++
  }
  return segments
}
