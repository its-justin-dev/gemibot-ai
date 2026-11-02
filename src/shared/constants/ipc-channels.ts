export const IPC = {
  APP: {
    GET_VERSION: 'app:get-version',
    GET_PLATFORM: 'app:get-platform'
  },
  FILE: {
    OPEN_DIALOG: 'file:open-dialog'
  },
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set'
  },
  CONFIG: {
    GET: 'config:get'
  },
  API_KEY: {
    GET: 'api-key:get',
    SET: 'api-key:set'
  },
  WINDOW: {
    EVENT: 'window:event',
    REQUEST: 'window:request',
    REPLY: 'window:reply',
    COMMAND: 'window:command',
    DIFF: 'window:diff',
    SAVE_DIALOG: 'window:save-dialog',
    SNAPSHOT: 'window:snapshot'
  }
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC][keyof (typeof IPC)[keyof typeof IPC]]
