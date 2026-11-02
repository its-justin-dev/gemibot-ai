import { GlyphText, stripGlyphs } from '@renderer/components/icons'
import OptionMenu from '@renderer/components/option-menu'
import type { RendererState, StaticCatalogs } from '@renderer/state/window-store'
import type { WindowCommand } from '@shared/types/window'

interface Props {
  state: RendererState
  catalogs: StaticCatalogs
  send: (command: WindowCommand) => void
  onSelectModel: () => void
}

export default function TopNav({ state, catalogs, send, onSelectModel }: Props): React.JSX.Element {
  return (
    <div className="top-nav">
      <div className="brand-box">
        <span className="logo-badge">AI</span>
        <span className="brand-title">GemiBot AI</span>
      </div>
      <span className="top-path" title={stripGlyphs(state.bar.topPath)}>
        <GlyphText text={state.bar.topPath} />
      </span>

      <div className="right">
        <button
          className={`build-mode-btn mode-${state.buildMode}`}
          onClick={() =>
            send({
              cmd: 'build-mode',
              mode: state.buildMode === 'auto' ? 'on' : state.buildMode === 'on' ? 'off' : 'auto'
            })
          }
          title="Cycle Build mode: Auto (whole-system requests) → On (always) → Off"
          type="button"
        >
          {`🏗 ${state.buildMode === 'auto' ? 'Auto' : state.buildMode === 'on' ? 'On' : 'Off'}`}
        </button>
        {state.multiAgent.isActive ? (
          <span
            className="status-badge multi-badge"
            style={{ color: '#a78bfa' }}
            title={`Multi-agent: ${state.multiAgent.completedSubTasks}/${state.multiAgent.totalSubTasks} sub-tasks done`}
          >
            {`🤖 ${state.multiAgent.completedSubTasks}/${state.multiAgent.totalSubTasks}`}
          </span>
        ) : null}
        <span className="status-badge" style={{ color: state.status.color }}>
          {state.status.text}
        </span>
        <button
          className="model-btn"
          onClick={onSelectModel}
          title={stripGlyphs(state.bar.modelButton)}
          type="button"
        >
          <GlyphText text={state.bar.modelButton} />
        </button>
        <OptionMenu
          ariaLabel="UI scale"
          className="font-menu"
          onSelect={(label) => send({ cmd: 'font-scale', label })}
          value={state.fontScale.label}
          values={catalogs.fontScaleOptions}
          wrapClassName="font"
        />
        <div aria-label="Mode" className="mode-seg" role="group">
          {catalogs.modeOptions.map((option) => (
            <button
              aria-checked={option === state.bar.mode}
              key={option}
              onClick={() => send({ cmd: 'mode-change', value: option })}
              role="radio"
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
