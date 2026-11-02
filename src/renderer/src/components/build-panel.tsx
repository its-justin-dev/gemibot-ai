import { useState } from 'react'

import { Glyph, GlyphText } from '@renderer/components/icons'
import type { RendererState } from '@renderer/state/window-store'
import type {
  BuildRunStatus,
  BuildStageRecord,
  BuildStageStatus,
  BuildTaskStatus
} from '@shared/types/build'
import { buildModeLabel } from '@shared/utils/build-settings'
import type { WindowCommand } from '@shared/types/window'

interface Props {
  state: RendererState
  send: (command: WindowCommand) => void
}

const STATUS_COLORS: Record<BuildRunStatus, string> = {
  running: '#60a5fa',
  paused: '#f59e0b',
  'awaiting-approval': '#f59e0b',
  success: '#10b981',
  failed: '#ef4444',
  stopped: '#9ca3af'
}

const STATUS_LABELS: Record<BuildRunStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  'awaiting-approval': 'Awaiting approval',
  success: 'Success',
  failed: 'Failed',
  stopped: 'Stopped'
}

const STAGE_COLORS: Record<BuildStageStatus, string> = {
  pending: '#6b7280',
  running: '#60a5fa',
  success: '#10b981',
  failed: '#ef4444',
  skipped: '#9ca3af'
}

const STAGE_LABELS: Record<BuildStageStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
  skipped: 'Skipped'
}

const TASK_COLORS: Record<BuildTaskStatus, string> = {
  pending: '#6b7280',
  running: '#60a5fa',
  succeeded: '#10b981',
  failed: '#ef4444',
  skipped: '#9ca3af'
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}m ${seconds}s`
}

function clock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleTimeString([], { hour12: false })
}

function count(value: number): string {
  return value.toLocaleString()
}

function StageRow({ stage }: { stage: BuildStageRecord }): React.JSX.Element {
  const color = STAGE_COLORS[stage.status]
  return (
    <div className="bp-stage" title={stage.detail || stage.output}>
      <span className="bp-stage-name">{stage.label}</span>
      <span className="bp-stage-state" style={{ color }}>
        {STAGE_LABELS[stage.status]}
      </span>
      <span className="bp-stage-model">{stage.model || '—'}</span>
      <span className="bp-stage-time">{clock(stage.startedAt)}</span>
      <span className="bp-stage-duration">{duration(stage.durationMs)}</span>
    </div>
  )
}

export default function BuildPanel({ state, send }: Props): React.JSX.Element | null {
  const view = state.build
  const [expanded, setExpanded] = useState(true)
  const [feedback, setFeedback] = useState('')
  if (view === null) return null

  const running = view.status === 'running'
  const paused = view.status === 'paused'
  const awaiting = view.status === 'awaiting-approval'
  const tokenPercent =
    view.tokenBudget > 0
      ? Math.max(0, Math.min(100, Math.round((view.tokensUsed / view.tokenBudget) * 100)))
      : 0
  const stepPercent =
    view.stepBudget > 0
      ? Math.max(0, Math.min(100, Math.round((view.stepsUsed / view.stepBudget) * 100)))
      : 0

  const revise = (): void => {
    const text = feedback.trim()
    if (text === '') return
    send({ cmd: 'build-revise', text })
    setFeedback('')
  }

  return (
    <div className="build-panel">
      <div className="bp-head">
        <span className="bp-icon">
          <Glyph glyph="🏗️" />
        </span>
        <span className="bp-title">BUILD</span>
        <span className="bp-state" style={{ color: STATUS_COLORS[view.status] }}>
          {STATUS_LABELS[view.status]}
        </span>
        <span className="bp-goal" title={view.goal}>
          {view.goal}
        </span>
        <span className="bp-meta">
          {`${view.completedMilestones}/${view.totalMilestones} milestones · ` +
            `${view.tasksDone}/${view.tasksTotal} tasks · ` +
            `${count(view.tokensUsed)}/${count(view.tokenBudget)} tokens · ` +
            `${view.repairAttempts}/${view.maxRepairAttempts} repairs`}
        </span>
        <div className="bp-actions">
          {running ? (
            <button className="bp-btn bp-pause" onClick={() => send({ cmd: 'build-pause' })} type="button">
              Pause
            </button>
          ) : null}
          {paused || view.status === 'failed' ? (
            <button className="bp-btn bp-resume" onClick={() => send({ cmd: 'build-resume' })} type="button">
              Resume
            </button>
          ) : null}
          {running || paused || awaiting ? (
            <button className="bp-btn bp-stop" onClick={() => send({ cmd: 'build-stop' })} type="button">
              Stop
            </button>
          ) : null}
          <button className="bp-btn bp-docs" onClick={() => send({ cmd: 'build-docs' })} type="button">
            Docs
          </button>
          <button
            aria-expanded={expanded}
            className="bp-btn bp-toggle"
            onClick={() => setExpanded((previous) => !previous)}
            type="button"
          >
            <Glyph glyph={expanded ? '▼' : '▶'} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="bp-body">
          <div className="bp-bars">
            <span className="bp-bar-label">Tokens</span>
            <span className="bp-bar">
              <span
                className={`bp-bar-fill${tokenPercent >= 80 ? ' is-high' : ''}`}
                style={{ width: `${tokenPercent}%` }}
              />
            </span>
            <span className="bp-bar-value">{`${tokenPercent}%`}</span>
            <span className="bp-bar-label">Steps</span>
            <span className="bp-bar">
              <span
                className={`bp-bar-fill${stepPercent >= 80 ? ' is-high' : ''}`}
                style={{ width: `${stepPercent}%` }}
              />
            </span>
            <span className="bp-bar-value">{`${stepPercent}%`}</span>
            <span className="bp-mode">{buildModeLabel(state.buildMode)}</span>
          </div>

          <div className="bp-stages">
            {view.stages.map((stage) => (
              <StageRow key={stage.stage} stage={stage} />
            ))}
          </div>

          {view.milestones.length > 0 ? (
            <div className="bp-milestones">
              {view.milestones.map((milestone) => {
                const done = milestone.taskResults.filter(
                  (task) => task.status === 'succeeded'
                ).length
                return (
                  <div className="bp-milestone" key={milestone.id}>
                    <span className="bp-milestone-title">{milestone.title}</span>
                    <span
                      className="bp-milestone-state"
                      style={{ color: TASK_COLORS[milestone.status] }}
                    >
                      {milestone.status}
                    </span>
                    <span className="bp-milestone-meta">
                      {`${done}/${milestone.taskResults.length} tasks` +
                        (milestone.attempts > 0 ? ` · ${milestone.attempts} attempt(s)` : '')}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : null}

          {awaiting ? (
            <div className="bp-approval">
              <div className="bp-approval-title">
                <GlyphText text="Plan ready — review before implementation starts." />
              </div>
              {view.summary ? <div className="bp-approval-summary">{view.summary}</div> : null}
              {view.assumptions.length > 0 ? (
                <ul className="bp-assumptions">
                  {view.assumptions.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              ) : null}
              <div className="bp-approval-row">
                <input
                  aria-label="Build feedback"
                  className="bp-feedback"
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder="Request a change (optional)..."
                  value={feedback}
                />
                <button
                  className="bp-btn bp-changes"
                  disabled={feedback.trim() === ''}
                  onClick={revise}
                  type="button"
                >
                  Request changes
                </button>
                <button
                  className="bp-btn bp-approve"
                  onClick={() => send({ cmd: 'build-approve' })}
                  type="button"
                >
                  Approve plan
                </button>
              </div>
            </div>
          ) : null}

          {view.error ? <div className="bp-error">{view.error}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
