import { useMemo } from 'react'
import { Badge, Button, Card, Empty, ScoreRing } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { LectureNotes, Markdown } from '../components/Markdown.jsx'
import { Topology } from '../services/Topology.jsx'
import { navigate } from '../lib/router.js'
import { useAuth } from '../auth/AuthProvider.jsx'
import { attemptScore, attemptsFor } from '../store/progress.js'
import { cardsForLab } from '../cards/index.js'
import { commandsForLab } from '../reference/index.js'
import { loadReview, statsFor } from '../cards/review.js'
import { DIFFICULTY_TONE, getLab, getPlayable, taskBudgetMs } from '../labs/index.js'
import { clockDuration, humanDuration } from '../lib/format.js'
import { compact, lectureBlocks, textBlock } from '../speech/speakable.js'
import { SpeechControl, SpokenBlocks, useAutoSpeak } from '../speech/SpokenBlocks.jsx'

export function LabDetail({ labId }) {
  const { user } = useAuth()
  const lab = getLab(labId)
  const play = getPlayable(labId)
  // A static preview — no attempt exists yet on this overview page, so there's no real
  // cluster state to show, only the 3 nodes every CNPG lab provisions.
  const world = useMemo(
    () =>
      play
        ? {
            kind: 'cnpg',
            nodes: [
              { id: 'k3d-server', role: 'control-plane', type: 'k3s' },
              { id: 'k3d-agent-1', role: '<none>', type: 'k3s' },
              { id: 'k3d-agent-2', role: '<none>', type: 'k3s' },
            ],
            k8s: { operator: { installed: false }, cluster: null },
          }
        : null,
    [play],
  )
  const attempts = useMemo(() => attemptsFor(user.id).filter((a) => a.labId === labId), [user.id, labId])

  // What else in the app covers this lab's material. Both relationships come from `usedIn`,
  // which is authored per card and per command entry and checked against the catalog — so
  // neither of these links is inferred from the text.
  const study = useMemo(() => {
    const cards = cardsForLab(labId)
    const commands = commandsForLab(labId)
    return {
      cards,
      commands,
      deckId: cards[0]?.deckId ?? null,
      refId: commands[0]?.refId ?? null,
      due: statsFor(cards, loadReview(user.id)).due,
    }
  }, [labId, user.id])

  // One continuous reading of the page, in the order the eye takes it: what this lab is,
  // what it asks of you, then the background. The three parts live in different cards, so
  // each renders its own slice and says where that slice starts.
  const speech = useMemo(() => {
    if (!lab) return { blocks: [], titleSlice: [], descSlice: [], notesStart: 0, notesSlice: [] }
    const title = compact([textBlock(lab.title)])
    const desc = compact([textBlock(lab.description)])
    const notes = lectureBlocks(lab.lectureNotes)
    return {
      blocks: [...title, ...desc, ...notes],
      titleSlice: title,
      descSlice: desc,
      descStart: title.length,
      notesStart: title.length + desc.length,
      notesSlice: notes,
    }
  }, [lab])

  const speechKey = lab ? `detail:${labId}` : null
  useAutoSpeak(speechKey, speech.blocks, !!speechKey)

  if (!lab) {
    return (
      <div className="p-5">
        <Card>
          <Empty icon={<Icon.Warn size={28} />} title="Lab not found">
            No lab with the id <code className="font-mono">{labId}</code> exists in this catalog.
          </Empty>
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={() => navigate('catalog')}>
              Back to catalog
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-5 p-5">
      <button
        onClick={() => navigate('catalog')}
        className="flex items-center gap-1 text-xs text-muted transition hover:text-fg"
      >
        <Icon.Chevron size={13} className="rotate-180" /> Back to catalog
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 text-xl font-semibold leading-snug">
              <SpokenBlocks speechKey={speechKey} blocks={speech.titleSlice} plain />
            </h3>
            <SpeechControl
              speechKey={speechKey}
              blocks={speech.blocks}
              label="Read this page"
              className="mt-1.5"
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={DIFFICULTY_TONE[lab.difficulty]}>{lab.difficulty}</Badge>
            <Badge tone="primary">{lab.database}</Badge>
            <Badge tone="muted">{lab.technology}</Badge>
            <Badge tone="muted">{lab.category}</Badge>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            <SpokenBlocks
              speechKey={speechKey}
              blocks={speech.descSlice}
              offset={speech.descStart}
              plain
            />
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2">
          {lab.playable ? (
            <Button onClick={() => navigate(`play/${lab.id}`)}>
              <Icon.Terminal size={15} /> Start Lab
            </Button>
          ) : (
            <div className="max-w-xs rounded-sm border border-dashed bg-surface p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <Icon.Info size={14} className="text-warning" /> Not wired in this mock
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                This lab is present in the catalog with its real content, but it has no
                provisioning recipe yet, so it cannot be played end to end. Its tasks and
                lecture notes are shown below.
              </p>
            </div>
          )}
          <div className="rounded-sm border bg-surface px-3 py-2 text-xs text-muted">
            <div className="flex items-center justify-between gap-4">
              <span>Session limit</span>
              <strong className="text-fg">{lab.timeLimitLabel}</strong>
            </div>
            <div className="mt-1 flex items-center justify-between gap-4">
              <span>Tasks</span>
              <strong className="text-fg">{lab.taskCount}</strong>
            </div>
            {play && (
              <div className="mt-1 flex items-center justify-between gap-4">
                <span>Task time budget</span>
                <strong className="text-fg">{humanDuration(taskBudgetMs(lab.id))}</strong>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <div className="space-y-5">
          <Card
            title={play ? 'Tasks' : 'Tasks in this lab'}
            subtitle={
              play
                ? 'Each task unlocks only when the previous one has been verified'
                : 'The real task list from the source catalog'
            }
            bodyClass="p-0"
          >
            {play ? (
              <ol className="divide-y">
                {play.tasks.map((t, i) => (
                  <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                        i === 0 ? 'bg-primary/15 text-primary' : 'bg-surface2 text-muted'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      {i === 0 ? (
                        <p className="text-sm font-medium">{t.title}</p>
                      ) : (
                        <p className="flex items-center gap-1.5 text-sm text-muted">
                          <Icon.Lock size={13} /> Revealed after task {i}
                        </p>
                      )}
                      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                        <Icon.Clock size={11} /> {clockDuration(t.limitSec * 1000)} limit
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="divide-y">
                {lab.steps.map((s, i) => (
                  <div key={s.id} className="px-4 py-3">
                    <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface2 text-[10px] font-semibold text-muted">
                        {i + 1}
                      </span>
                      {s.title}
                    </p>
                    <Markdown text={s.instructions} />
                    {s.hint && (
                      <p className="mt-2 flex gap-1.5 rounded-sm bg-warning/10 p-2 text-xs text-muted">
                        <Icon.Bulb size={13} className="mt-px shrink-0 text-warning" />
                        <span>{s.hint}</span>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Lecture notes"
            subtitle="Background reading on the technology this lab exercises"
            action={<SpeechControl speechKey={speechKey} blocks={speech.blocks} label="Read this page" />}
          >
            {speech.notesSlice.length ? (
              <SpokenBlocks
                speechKey={speechKey}
                blocks={speech.notesSlice}
                offset={speech.notesStart}
                className="space-y-4"
              />
            ) : (
              <LectureNotes text={lab.lectureNotes} />
            )}
          </Card>
        </div>

        <div className="space-y-5">
          {world && (
            <Card title="Topology" subtitle="The cluster this lab provisions">
              <Topology world={world} />
              <div className="mt-3 space-y-1.5 border-t pt-3">
                {play.terminals.map((id) => (
                  <div key={id} className="flex items-center gap-2 text-xs">
                    <Icon.Terminal size={13} className="text-muted" />
                    <span className="font-mono">{id}</span>
                    <span className="text-muted">terminal</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {(study.cards.length > 0 || study.commands.length > 0) && (
            <Card title="Study this material" subtitle="The same ground, arranged for recall and for lookup">
              <div className="space-y-2">
                {study.cards.length > 0 && (
                  <div className="flex items-center gap-3 rounded-sm border bg-bg p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium">
                        {study.cards.length} index card{study.cards.length === 1 ? '' : 's'}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {study.due > 0 ? `${study.due} due now` : 'nothing due — study them anyway'}
                      </p>
                    </div>
                    <Button size="xs" onClick={() => navigate(`cards/${study.deckId}/lab/${labId}`)}>
                      <Icon.Bulb size={13} /> Study
                    </Button>
                  </div>
                )}
                {study.commands.length > 0 && (
                  <div className="flex items-center gap-3 rounded-sm border bg-bg p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium">
                        {study.commands.length} command{study.commands.length === 1 ? '' : 's'}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted">each with a real example and its real output</p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => navigate(`reference/${study.refId}/lab/${labId}`)}
                    >
                      <Icon.Book size={13} /> Reference
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          )}

          <Card title="Your attempts" subtitle={attempts.length ? `${attempts.length} on record` : 'None yet'}>
            {attempts.length === 0 ? (
              <p className="text-xs text-muted">
                You have not attempted this lab. Scores appear here once you finish a task.
              </p>
            ) : (
              <div className="space-y-3">
                {attempts.slice(0, 5).map((a) => {
                  const total = play ? play.tasks.length : lab.taskCount
                  const done = a.tasks.filter((t) => t.status === 'passed' || t.status === 'late').length
                  return (
                    <div key={a.id} className="flex items-center gap-3 rounded-sm border bg-bg p-3">
                      <ScoreRing value={attemptScore(a, total)} size={52} stroke={6} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium">
                          {done} of {total} tasks
                          {a.finishedAt ? '' : ' · in progress'}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted">
                          {new Date(a.startedAt).toLocaleString()}
                        </p>
                      </div>
                      {!a.finishedAt && (
                        <Button size="xs" variant="outline" onClick={() => navigate(`play/${lab.id}`)}>
                          Resume
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
