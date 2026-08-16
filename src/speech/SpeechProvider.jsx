import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Narration, on the browser's own `speechSynthesis` — no dependency, no bytes shipped,
 * no network. Voices come from the learner's OS, which is why the settings menu lets
 * them pick one: what is installed differs on every machine.
 *
 * The provider owns three things: the settings (on/off + chosen voice, persisted like
 * the theme), the queue of utterances, and the "which word is being said right now"
 * position that components highlight from.
 *
 * One utterance per block, spoken in order. `onboundary` gives a character offset into
 * the *current* utterance only, so keeping utterances small is what keeps the highlight
 * honest — see src/speech/speakable.js.
 *
 * Most of what follows is defensive against Chrome specifically. Its Web Speech
 * implementation has several long-standing quirks that all present identically — total
 * silence, no error in the console — and each one is called out at the code that handles
 * it. Firefox and Safari need none of it but are unharmed by it.
 */

const ENABLED_KEY = 'dbcanvas_labs_voice'
const VOICE_KEY = 'dbcanvas_labs_voice_uri'

const PREFERRED_LANG = 'en-US'

/**
 * The voice this machine starts with, until the learner picks their own.
 *
 * Keyed on the operating system rather than the browser, because that is where voices
 * actually come from: Safari and Chrome on a Mac see the same Samantha, Edge and Chrome
 * on Windows see the same Zira. Naming them (rather than taking whatever the browser
 * calls default) picks the familiar, good-quality voice on each platform; matching is by
 * prefix, since the installed name is usually longer than the recognisable part — Windows
 * exposes Zira as "Microsoft Zira - English (United States)".
 */
const PLATFORM_VOICES = [
  {
    id: 'apple',
    label: 'macOS',
    test: (p, ua) => /Mac|iPhone|iPad|iPod/.test(p) || /Mac OS X|iPhone|iPad/.test(ua),
    names: ['Samantha', 'Alex', 'Ava'],
  },
  {
    id: 'windows',
    label: 'Windows',
    test: (p, ua) => /Win/.test(p) || /Windows/.test(ua),
    names: ['Microsoft Zira', 'Microsoft David', 'Microsoft Mark'],
  },
]

/** Which of the above this machine is, or null for anything else (Linux, say). */
function detectPlatform() {
  if (typeof navigator === 'undefined') return null
  const p = navigator.userAgentData?.platform || navigator.platform || ''
  const ua = navigator.userAgent || ''
  return PLATFORM_VOICES.find((x) => x.test(p, ua)) || null
}

const platform = detectPlatform()

/**
 * Network voices are never used.
 *
 * They are the ones the browser streams from a vendor's servers — everything named
 * "Google …" in Chrome, the "… Online (Natural)" voices in Edge — and they are wrong for
 * this app three times over. They fire no word-boundary events in Chrome, so the
 * highlighting this feature exists for degrades to an estimate. They send the lab text
 * off the machine to a third party. And they stop working entirely without internet,
 * which defeats the point of an app that otherwise runs completely self-contained.
 *
 * The one exception is a machine that has nothing else — better an imperfect voice than
 * silence — which is what `usableVoices` decides.
 */
export function isLocalVoice(v) {
  return v.localService !== false
}

/** The voices offered and chosen from: local only, unless there are no local ones. */
export function usableVoices(voices) {
  const local = voices.filter(isLocalVoice)
  return local.length ? local : voices
}

function namedVoice(voices, want) {
  const target = want.toLowerCase()
  return (
    voices.find((v) => v.name?.toLowerCase() === target) ||
    voices.find((v) => v.name?.toLowerCase().startsWith(target)) ||
    voices.find((v) => v.name?.toLowerCase().includes(target))
  )
}

/** How long to wait for `voiceschanged` before giving up and speaking anyway. */
const VOICES_GRACE_MS = 1200

const SpeechCtx = createContext(null)

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
export const speechSupported = !!synth

function readEnabled() {
  try {
    // Disabled by default: absent key means "off", only an explicit "on" enables it.
    return localStorage.getItem(ENABLED_KEY) === 'on'
  } catch {
    return false
  }
}

function readVoiceURI() {
  try {
    return localStorage.getItem(VOICE_KEY) || ''
  } catch {
    return ''
  }
}

/** en-US first, then other English, then everything else — alphabetical within each. */
function rankVoices(voices) {
  const score = (v) => (v.lang === PREFERRED_LANG ? 0 : v.lang?.startsWith('en') ? 1 : 2)
  return [...voices].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
}

/**
 * The default voice, when the learner has not chosen one.
 *
 * First choice is the voice named for this platform (Samantha on a Mac, Microsoft Zira
 * on Windows). Those names can be absent — a stripped Windows install may have no Zira,
 * Linux has neither — so it falls back through: any en-US, then any English, then
 * whatever exists. `voices` is already filtered to local by usableVoices.
 */
function pickDefault(voices) {
  const english = voices.filter((v) => v.lang?.startsWith('en'))
  for (const want of platform?.names || []) {
    const hit = namedVoice(english, want)
    if (hit) return hit
  }
  const enUS = voices.filter((v) => v.lang === PREFERRED_LANG)
  return enUS.find((v) => v.default) || enUS[0] || english.find((v) => v.default) || english[0] || voices[0] || null
}

export function SpeechProvider({ children }) {
  const [enabled, setEnabledState] = useState(readEnabled)
  const [voices, setVoices] = useState([])
  const [voicesSettled, setVoicesSettled] = useState(false)
  const [voiceURI, setVoiceURIState] = useState(readVoiceURI)
  // What is being spoken right now: which target, which block of it, and where inside
  // that block. `null` means silent.
  const [active, setActive] = useState(null)
  // Chrome refuses to speak until the document has been interacted with, and reports it
  // as an utterance error rather than throwing. Surfaced so the UI can say so, and
  // retried automatically on the next click.
  const [blocked, setBlocked] = useState(false)

  const activeRef = useRef(null)
  activeRef.current = active
  const blockedRef = useRef(false)
  blockedRef.current = blocked
  // The last thing asked for, kept so a gesture-blocked reading can be replayed.
  const pendingRef = useRef(null)
  const startTimerRef = useRef(0)
  // Timer driving the estimated highlight for voices that report no word boundaries.
  const estimateRef = useRef(0)

  /* Voice list. getVoices() is famously empty on first call in Chrome — the list arrives
     asynchronously via voiceschanged, sometimes more than once. The grace timer means a
     browser that never fires the event cannot leave narration permanently mute. */
  useEffect(() => {
    if (!synth) return
    const load = () => {
      const list = synth.getVoices()
      if (!list.length) return
      // Chrome fires voiceschanged more than once, and hands back fresh voice objects
      // each time. Swapping state for an identical list would change the resolved voice
      // by identity, which restarts whatever is being read — so only take a real change.
      setVoices((cur) => {
        // Network voices are dropped here, at the source, so nothing downstream — the
        // default, the picker, a stored preference — can end up on one.
        const next = rankVoices(usableVoices(list))
        const same =
          cur.length === next.length && cur.every((v, i) => v.voiceURI === next[i].voiceURI)
        return same ? cur : next
      })
      setVoicesSettled(true)
    }
    load()
    synth.addEventListener('voiceschanged', load)
    const grace = setTimeout(() => setVoicesSettled(true), VOICES_GRACE_MS)
    return () => {
      synth.removeEventListener('voiceschanged', load)
      clearTimeout(grace)
    }
  }, [])

  /* Nothing should still be talking after a reload or a tab close — the synthesizer
     lives on the window, not in React, and it will happily keep going without us. */
  useEffect(() => {
    if (!synth) return
    const stopAll = () => synth.cancel()
    window.addEventListener('beforeunload', stopAll)
    return () => window.removeEventListener('beforeunload', stopAll)
  }, [])

  const defaultVoice = useMemo(() => (voices.length ? pickDefault(voices) : null), [voices])

  /* The learner's pick wins; otherwise this browser's default. A stored voiceURI that
     matches nothing simply falls through — which is what happens when the same account
     opens the app in a different browser, since voiceURIs are not portable. */
  const resolvedVoice = useMemo(() => {
    if (!voices.length) return null
    return voices.find((v) => v.voiceURI === voiceURI) || defaultVoice
  }, [voices, voiceURI, defaultVoice])

  const stop = useCallback(() => {
    clearTimeout(startTimerRef.current)
    clearInterval(estimateRef.current)
    estimateRef.current = 0
    pendingRef.current = null
    if (synth) synth.cancel()
    setActive(null)
  }, [])

  /** Queues the utterances for real. Never call this in the same tick as cancel(). */
  const enqueue = useCallback(
    (key, blocks) => {
      if (!synth) return
      const voice = resolvedVoice

      blocks.forEach((block, index) => {
        const u = new SpeechSynthesisUtterance(block.text)
        if (voice) {
          u.voice = voice
          u.lang = voice.lang
        } else {
          u.lang = PREFERRED_LANG
        }
        // Slightly under conversational pace: this is technical prose full of object
        // names, and the learner is reading along with it.
        u.rate = 0.95

        // Real boundary events always win. This only tracks whether any arrived, so the
        // estimator below can bow out the moment the browser starts telling the truth.
        let gotBoundary = false

        const stopEstimate = () => {
          clearInterval(estimateRef.current)
          estimateRef.current = 0
        }

        u.onstart = () => {
          // Something actually came out — so we are not gesture-blocked after all.
          if (blockedRef.current) setBlocked(false)
          setActive({ key, block: index, charIndex: -1 })

          /* Not every voice reports word boundaries. Chrome fires none at all for its
             network voices, and a learner watching a paragraph that never lights up has
             no idea why. So drive the highlight from the clock instead: speech is close
             enough to linear in characters that walking a synthetic charIndex across the
             block keeps the highlight within a word or so of the audio. It is an
             approximation, and it is only ever used when the alternative is nothing. */
          stopEstimate()
          const startedAt = Date.now()
          const charsPerMs = (16 * u.rate) / 1000
          estimateRef.current = setInterval(() => {
            if (gotBoundary) return stopEstimate()
            const est = Math.floor((Date.now() - startedAt) * charsPerMs)
            if (est > block.text.length) return stopEstimate()
            setActive((cur) => (cur && cur.key === key ? { ...cur, block: index, charIndex: est } : cur))
          }, 60)
        }

        u.onboundary = (e) => {
          if (e.name && e.name !== 'word') return
          gotBoundary = true
          stopEstimate()
          setActive((cur) => (cur && cur.key === key ? { ...cur, block: index, charIndex: e.charIndex } : cur))
        }

        u.onerror = (e) => {
          stopEstimate()
          // "interrupted"/"canceled" are what every queued utterance reports when we
          // deliberately stop one reading to start another. They are not failures.
          if (e.error === 'interrupted' || e.error === 'canceled') return
          // Chrome's autoplay policy: speak() before the document has been clicked is
          // refused outright. Hold the request; the gesture listener below replays it.
          if (e.error === 'not-allowed') setBlocked(true)
          setActive((cur) => (cur && cur.key === key ? null : cur))
        }

        u.onend = () => {
          stopEstimate()
          if (index === blocks.length - 1) {
            pendingRef.current = null
            setActive((cur) => (cur && cur.key === key ? null : cur))
          }
        }

        synth.speak(u)
      })
    },
    [resolvedVoice],
  )

  /**
   * Speak `blocks` (from speakable.js) as one target identified by `key`.
   *
   * Idempotent per key: asking for the target that is already speaking is a no-op, so
   * repeated renders cannot stack two voices. Speaking a *different* key replaces it.
   */
  const speak = useCallback(
    (key, blocks) => {
      if (!synth || !enabled || !key || !blocks?.length) return
      if (activeRef.current?.key === key) return

      pendingRef.current = { key, blocks }
      clearTimeout(startTimerRef.current)
      synth.cancel()
      // Chrome drops an utterance queued in the same tick as cancel(): its dispatcher is
      // still tearing the previous queue down and the new one lands in the debris. One
      // turn of the event loop later is reliable, and the delay is imperceptible.
      startTimerRef.current = setTimeout(() => enqueue(key, blocks), 60)
    },
    [enabled, enqueue],
  )

  /* Chrome's autoplay policy again: the first speak() of a session can be refused for
     want of a user gesture, silently. Any click or keypress re-arms it, so replay what
     was asked for rather than leaving the learner wondering. Passive and capturing so it
     sees the interaction whatever handles it. */
  useEffect(() => {
    if (!synth) return
    const retry = () => {
      if (!blockedRef.current) return
      const p = pendingRef.current
      if (!p) return
      setBlocked(false)
      clearTimeout(startTimerRef.current)
      startTimerRef.current = setTimeout(() => enqueue(p.key, p.blocks), 0)
    }
    document.addEventListener('pointerdown', retry, { capture: true, passive: true })
    document.addEventListener('keydown', retry, { capture: true, passive: true })
    return () => {
      document.removeEventListener('pointerdown', retry, { capture: true })
      document.removeEventListener('keydown', retry, { capture: true })
    }
  }, [enqueue])

  const setEnabled = useCallback(
    (next) => {
      setEnabledState(next)
      try {
        localStorage.setItem(ENABLED_KEY, next ? 'on' : 'off')
      } catch {
        /* private mode */
      }
      // Turning it off is also a stop: the master switch has to silence what is already
      // in flight, not just prevent the next thing.
      if (!next) stop()
    },
    [stop],
  )

  const setVoiceURI = useCallback(
    (uri) => {
      setVoiceURIState(uri || '')
      try {
        // An empty choice means "go back to this browser's default" — remove the key
        // rather than storing a blank, so the default can keep evolving.
        if (uri) localStorage.setItem(VOICE_KEY, uri)
        else localStorage.removeItem(VOICE_KEY)
      } catch {
        /* private mode */
      }
      // A voice change mid-sentence would finish the queue in the old voice; stop
      // instead, so the next thing spoken is unambiguously the voice just chosen.
      stop()
    },
    [stop],
  )

  const resetVoice = useCallback(() => setVoiceURI(''), [setVoiceURI])

  /* Chrome stops speaking after roughly 15 seconds of a single queue unless something
     nudges it. The dependency is the *boolean*, not `active` itself: active changes on
     every word, and an interval rebuilt every few hundred milliseconds would never live
     long enough to fire. resume() is unconditional — a queue Chrome has quietly paused
     is exactly the case this exists to rescue, and it is a no-op otherwise. */
  const speaking = active !== null
  useEffect(() => {
    if (!synth || !speaking) return
    const id = setInterval(() => synth.resume(), 8000)
    return () => clearInterval(id)
  }, [speaking])

  const value = useMemo(
    () => ({
      supported: speechSupported,
      enabled,
      setEnabled,
      voices,
      /** Chrome hands the voice list over asynchronously, so anything that starts
       *  speaking *by itself* waits for it — otherwise the first thing a learner hears
       *  on a fresh page load is the browser's default voice rather than the one they
       *  chose. Settled (not "non-empty") so a browser that reports no voices at all
       *  still gets to try. */
      voicesReady: voicesSettled,
      voice: resolvedVoice,
      voiceURI,
      setVoiceURI,
      /** This machine's out-of-the-box voice, and the name it is meant to be. */
      defaultVoice,
      platformLabel: platform?.label || null,
      platformVoiceName: platform?.names[0] || null,
      /** True when the learner has overridden the default. */
      customised: !!voiceURI && voices.some((v) => v.voiceURI === voiceURI),
      resetVoice,
      speak,
      stop,
      active,
      blocked,
      /** True when `key` is the thing currently being spoken. */
      isSpeaking: (key) => active?.key === key,
    }),
    [
      enabled,
      setEnabled,
      voices,
      voicesSettled,
      resolvedVoice,
      voiceURI,
      setVoiceURI,
      defaultVoice,
      resetVoice,
      speak,
      stop,
      active,
      blocked,
    ],
  )

  return <SpeechCtx.Provider value={value}>{children}</SpeechCtx.Provider>
}

export function useSpeech() {
  return useContext(SpeechCtx)
}
