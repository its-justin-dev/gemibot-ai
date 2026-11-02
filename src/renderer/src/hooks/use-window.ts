import { useCallback, useEffect, useRef, useState } from 'react'

import {
  apply,
  applyAnswer,
  applyRequest,
  createStore,
  type Store
} from '@renderer/state/window-store'
import type { FileDiffDict } from '@shared/models/file-diff'
import type {
  TimelineSaveTarget,
  WindowAnswer,
  WindowCommand,
  WindowEvent,
  WindowRequest,
  WindowSnapshot
} from '@shared/types/window'

export interface WindowClient {
  store: Store
  send: (command: WindowCommand) => void
  answer: (kind: WindowRequest['kind'], id: number, value: WindowAnswer) => void
  getDiff: (path: string) => Promise<FileDiffDict | null>
  pickSaveTimelineFile: () => Promise<TimelineSaveTarget | null>
}

export function useWindow(): WindowClient | null {
  const [store, setStore] = useState<Store | null>(null)
  const [, render] = useState({})
  const ref = useRef<Store | null>(null)

  useEffect(() => {
    let disposed = false
    let built: Store | null = null
    const eventQueue: WindowEvent[] = []
    const requestQueue: WindowRequest[] = []
    const notify = (): void => {
      if (!disposed) render({})
    }

    const offEvent = window.api.onWindowEvent((event) => {
      if (built === null) eventQueue.push(event)
      else apply(built, event)
    })

    const offRequest = window.api.onWindowRequest((request) => {
      if (built === null) requestQueue.push(request)
      else applyRequest(built, request)
    })

    void window.api.getWindowSnapshot().then((snapshot: WindowSnapshot) => {
      if (disposed) return
      built = createStore(snapshot)
      ref.current = built
      built.listeners.add(notify)
      for (const event of eventQueue.splice(0)) apply(built, event)
      for (const request of requestQueue.splice(0)) applyRequest(built, request)
      setStore(built)
    })

    return () => {
      disposed = true
      offEvent()
      offRequest()
      built?.listeners.delete(notify)
      ref.current = null
    }
  }, [])

  const send = useCallback((command: WindowCommand): void => {
    window.api.sendWindowCommand(command)
  }, [])

  const answer = useCallback(
    (kind: WindowRequest['kind'], id: number, value: WindowAnswer): void => {
      window.api.replyWindowRequest(id, value)
      const current = ref.current
      if (current !== null) applyAnswer(current, kind)
    },
    []
  )

  if (store === null) return null

  return {
    store,
    send,
    answer,
    getDiff: (path: string) => window.api.getDiff(path),
    pickSaveTimelineFile: () => window.api.pickSaveTimelineFile()
  }
}
