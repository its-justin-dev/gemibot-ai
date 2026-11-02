import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import ApiKeyDialog from '@renderer/components/api-key-dialog'
import BuildDocsDialog from '@renderer/components/build-docs-dialog'
import BuildPanel from '@renderer/components/build-panel'
import ConsolePane from '@renderer/components/console-pane'
import ConfirmClearDialog from '@renderer/components/confirm-clear-dialog'
import ChangesDrawer from '@renderer/components/changes-drawer'
import InputDock from '@renderer/components/input-dock'
import { ModelPicker } from '@renderer/components/model-picker'
import PermissionDialog from '@renderer/components/permission-dialog'
import ReviewPanel from '@renderer/components/review-panel'
import Sidebar from '@renderer/components/sidebar'
import Timeline, { type TimelineHandlers } from '@renderer/components/timeline'
import TopNav from '@renderer/components/top-nav'
import { useWindow } from '@renderer/hooks/use-window'
import {
  isHtmlExport,
  renderTimelineHtml,
  renderTimelineMarkdown
} from '@renderer/state/timeline-export'
import { closeModelPicker, closeReviewPanel } from '@renderer/state/window-store'

export default function App(): React.JSX.Element | null {
  const client = useWindow()
  const send = client?.send
  const [apiKeyOpen, setApiKeyOpen] = useState(false)

  useEffect(() => {
    if (send === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key.toLowerCase() === 'm') send({ cmd: 'model-picker' })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [send])

  const handlers = useMemo<TimelineHandlers>(
    () => ({
      copy: (text) => send?.({ cmd: 'copy', text }),
      copyPath: (rel) => send?.({ cmd: 'copy-path', rel }),
      openFile: (rel) => send?.({ cmd: 'open-file', rel }),
      undo: () => send?.({ cmd: 'action', name: 'undo' }),
      editUser: (rowId, text, cpIdx, dbId) =>
        send?.({ cmd: 'edit-user', text, cpIdx, rowId, dbId }),
      openApiKey: () => setApiKeyOpen(true),
      loadOlder: () => send?.({ cmd: 'load-older' }),
      openConversation: (id) => send?.({ cmd: 'conversation-open', id }),
      compact: () => send?.({ cmd: 'compact' }),
      exportTimeline: () => {
        if (client === null) return
        void client.pickSaveTimelineFile().then((target) => {
          if (target === null) return
          const current = client.store.state
          const content = isHtmlExport(target.path)
            ? renderTimelineHtml(current, target)
            : renderTimelineMarkdown(current, target)
          send?.({ cmd: 'export-timeline', path: target.path, content })
        })
      }
    }),
    [client, send]
  )

  if (client === undefined || client === null || send === undefined) return null

  const { state, catalogs, console: buffer } = client.store
  const { getDiff } = client
  const closeReview = (): void => {
    send({ cmd: 'review-panel-close' })
    closeReviewPanel(client.store)
  }
  const style = {
    '--s': state.fontScale.scale,
    '--fs': state.fontScale.size,
    '--d': window.devicePixelRatio
  } as CSSProperties

  return (
    <div className="win" style={style}>
      <TopNav
        catalogs={catalogs}
        onSelectModel={() => send({ cmd: 'model-picker' })}
        send={send}
        state={state}
      />
      <div className="body">
        <Sidebar catalogs={catalogs} send={send} state={state} />
        <Timeline handlers={handlers} state={state}>
          <BuildPanel send={send} state={state} />
          <ChangesDrawer send={send} state={state} />
          <InputDock send={send} state={state} />
        </Timeline>
        <ConsolePane
          answer={client.answer}
          buffer={buffer}
          readLine={state.dialog.readLine}
          scale={state.fontScale.scale}
        />
      </div>
      {state.reviewPanel !== null ? (
        <ReviewPanel
          changes={state.reviewPanel}
          getDiff={getDiff}
          onClose={closeReview}
          send={send}
          state={state}
        />
      ) : null}
      {state.picker !== null ? (
        <ModelPicker
          onClose={() => closeModelPicker(client.store)}
          payload={state.picker}
          send={send}
        />
      ) : null}
      {state.dialog.permission !== null ? (
        <PermissionDialog
          answer={client.answer}
          detail={state.dialog.permission.detail}
          id={state.dialog.permission.id}
          tool={state.dialog.permission.tool}
        />
      ) : null}
      {state.dialog.confirmClear !== null ? (
        <ConfirmClearDialog answer={client.answer} id={state.dialog.confirmClear.id} />
      ) : null}
      {state.buildDocs.open ? (
        <BuildDocsDialog
          docs={state.buildDocs.docs}
          onClose={() => send({ cmd: 'build-docs-close' })}
        />
      ) : null}
      {apiKeyOpen ? <ApiKeyDialog onClose={() => setApiKeyOpen(false)} /> : null}
    </div>
  )
}
