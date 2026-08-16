import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icons.jsx'
import { Toggle } from '../components/ui.jsx'
import { useSpeech } from './SpeechProvider.jsx'

/**
 * Narration settings, sitting next to the theme picker for the same reason: it is a
 * preference about how the app presents itself, not part of any lab.
 *
 * Off by default, on with one click. The list is the locally installed voices — network
 * voices are filtered out upstream (see usableVoices) — with US English first, and it
 * scrolls because macOS ships a lot of them.
 */
export function VoicePicker() {
  const {
    supported,
    enabled,
    setEnabled,
    voices,
    voice,
    setVoiceURI,
    defaultVoice,
    platformLabel,
    platformVoiceName,
    customised,
    resetVoice,
    active,
    stop,
    blocked,
  } = useSpeech()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  // No Web Speech API (an old browser, or one with it compiled out) — say nothing rather
  // than offering a control that cannot work.
  if (!supported) return null

  const speaking = !!active

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded-sm p-2 transition hover:bg-surface2 hover:text-fg ${
          enabled ? 'text-muted' : 'text-muted opacity-60'
        }`}
        aria-label="Narration"
        title={enabled ? `Narration on — ${voice?.name || 'default voice'}` : 'Narration off'}
      >
        {enabled ? (
          <Icon.Speaker size={17} className={speaking ? 'text-primary' : undefined} />
        ) : (
          <Icon.SpeakerOff size={17} />
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-1 w-72 animate-fade-in overflow-hidden rounded-sm border bg-surface shadow-xl">
          <div className="flex items-center gap-3 px-3 py-2.5 rule-b">
            <div className="min-w-0">
              <p className="text-xs font-medium">Narration</p>
              <p className="mt-0.5 text-[10.5px] leading-snug text-muted">
                Reads the lab overview and each objective aloud, highlighting as it goes.
              </p>
            </div>
            <Toggle checked={enabled} onChange={setEnabled} label="Narration" />
          </div>

          {enabled && (
            <>
              {blocked && (
                <p className="flex gap-1.5 bg-warning/10 px-3 py-2 text-[10.5px] leading-snug text-muted">
                  <Icon.Info size={13} className="mt-px shrink-0 text-warning" />
                  <span>
                    Chrome will not start audio until you have interacted with the page. Click
                    anywhere and it will pick up from there.
                  </span>
                </p>
              )}
              {speaking && (
                <button
                  onClick={() => {
                    stop()
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-primary transition hover:bg-surface2"
                >
                  <Icon.SpeakerOff size={13} /> Mute what is playing
                </button>
              )}
              <div className="flex items-baseline gap-2 px-3 pb-1 pt-2">
                <p className="microlabel">Voice</p>
                {customised && defaultVoice && (
                  <button
                    onClick={() => {
                      resetVoice()
                      setOpen(false)
                    }}
                    className="ml-auto text-[10px] text-primary transition hover:underline"
                    title={`Back to ${defaultVoice.name}`}
                  >
                    use the default
                  </button>
                )}
              </div>
              {/* Says which voice this machine starts with, and — when the named one is
                  missing (Zira on a Mac, say) — what it fell back to instead. */}
              {defaultVoice && platformVoiceName && (
                <p className="px-3 pb-1.5 text-[10px] leading-snug text-muted">
                  {platformLabel} defaults to <span className="text-fg">{platformVoiceName}</span>
                  {!defaultVoice.name.toLowerCase().includes(platformVoiceName.toLowerCase()) && (
                    <> — not installed here, so <span className="text-fg">{defaultVoice.name}</span> is used</>
                  )}
                  . Only voices installed on this machine are offered.
                </p>
              )}
              <div className="max-h-64 overflow-y-auto pb-1">
                {voices.length === 0 && (
                  <p className="px-3 py-2 text-[11px] text-muted">
                    No voices installed on this system.
                  </p>
                )}
                {voices.map((v) => (
                  <button
                    key={v.voiceURI}
                    onClick={() => {
                      setVoiceURI(v.voiceURI)
                      setOpen(false)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-surface2"
                    // A network voice only ever reaches this list on a machine with no
                    // local ones at all. Flag it: it sends text to the vendor, needs
                    // internet, and its word highlighting is estimated.
                    title={
                      v.localService === false
                        ? 'Streamed from the vendor — needs internet, and word highlighting is estimated'
                        : undefined
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    {defaultVoice?.voiceURI === v.voiceURI && (
                      <span className="shrink-0 text-[10px] text-muted">default</span>
                    )}
                    {v.localService === false && (
                      <span className="shrink-0 text-[10px] text-warning">network</span>
                    )}
                    <span className="data shrink-0 text-muted">{v.lang}</span>
                    {voice?.voiceURI === v.voiceURI && (
                      <Icon.Check size={13} className="shrink-0 text-primary" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
