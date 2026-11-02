# Gemibot Prototype

Desktop app prototype built with **Electron + electron-vite + React + TypeScript + Tailwind CSS 4**,
packaged with **electron-builder**. Follows the professional structure described in
[electron-js-setup-guide.md](./electron-js-setup-guide.md).

## Requirements

- Node.js LTS (tested on v24)
- npm

## Quick start

```bash
npm install     # also downloads the Electron binary
npm run dev     # hot reload: renderer HMR, main/preload rebuild on save
```

F12 opens DevTools for the renderer. Editing `src/main` or `src/preload` restarts the app.

## Scripts

| Command                | What it does                                            |
| ---------------------- | ------------------------------------------------------- |
| `npm run dev`          | Dev mode with HMR                                       |
| `npm run build`        | Typecheck (node + web) and bundle main/preload/renderer |
| `npm start`            | Preview the built app                                   |
| `npm run dist`         | Build + produce the Windows NSIS installer in `dist/`   |
| `npm run build:unpack` | Build + an unpacked app folder for quick inspection     |
| `npm run lint`         | ESLint                                                  |
| `npm run format`       | Prettier                                                |
| `npm run typecheck`    | `tsc --noEmit` for both the Node and browser configs    |
| `npm test`             | Vitest unit tests (`tests/unit`)                        |
| `npm run test:e2e`     | Build, then drive the real app with Playwright          |

## Project layout

```
src/
  main/        Main process: lifecycle, windows, IPC handlers, services, menu
    ipc/       One file per domain; validates input, then calls a service
    services/  Business logic; no window or IPC knowledge (settings, file, logger)
    windows/   Window creation + a registry of open windows
    menu/      Application menu template
    utils/     Filesystem paths (dev vs packaged)
  preload/     The only bridge: a small typed API exposed via contextBridge
  renderer/    React UI. Treat it as a web app with no Node access
  shared/      Constants + types used by all three contexts (no Node/DOM code)
tests/
  unit/        Vitest, pure functions
  e2e/         Playwright driving the built Electron app
build/         Installer icons and macOS entitlements
resources/     Static files shipped with the app (read via paths.resource)
```

## How the layers talk

```
renderer component -> services/app-api.ts -> window.api (preload) -> ipcRenderer.invoke
                                                                        |
                                             ipc/*.handlers.ts -> services/*.service.ts
```

- Channel names live in one place: [src/shared/constants/ipc-channels.ts](./src/shared/constants/ipc-channels.ts).
- The preload exposes named functions only, never raw `ipcRenderer`
  ([src/preload/index.ts](./src/preload/index.ts)). `window.api` is typed from that same object via
  [src/preload/index.d.ts](./src/preload/index.d.ts), so the renderer gets autocompletion.
- Every payload entering the main process is validated before use, e.g.
  [src/shared/utils/settings.ts](./src/shared/utils/settings.ts).
- Logs go through `electron-log` and persist to disk, so production issues are still diagnosable.

## Configuration

Copy `.env.example` to `.env` (gitignored) and edit. There are two kinds of variable and the
difference matters:

| Kind                   | Prefix                                                | Read with                           | Where it can go                           |
| ---------------------- | ----------------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| Build-time, non-secret | `MAIN_VITE_` `PRELOAD_VITE_` `RENDERER_VITE_` `VITE_` | `import.meta.env.X` in that context | anywhere, but **inlined into the bundle** |
| Runtime, secret        | none (e.g. `GEMIBOT_API_KEY`)                         | `process.env['X']`                  | main process only                         |

electron-vite substitutes prefixed variables at build time, so anyone who unpacks the `app.asar` can
read them - treat them as public. Anything unprefixed is loaded at startup by
[src/main/services/config.service.ts](./src/main/services/config.service.ts) with
`process.loadEnvFile()`, from the project `.env` in development or `<userData>/.env` in a packaged
app, and never reaches the bundle.

The main process turns those into a validated, non-secret view via the pure
[buildMainConfig()](./src/shared/utils/config.ts) helper - it reports `hasApiKey` rather than the key
itself - and hands it to the renderer over `config:get`. Adding a variable means: declare it in
`EnvSource` + `src/main/env.d.ts`, read it in the service, and surface it in the Runtime card.

## Styling

Tailwind v4 runs through `@tailwindcss/vite` (registered in the renderer block of
[electron.vite.config.ts](./electron.vite.config.ts)) and needs no `tailwind.config.js`. Everything
visual is driven from [src/renderer/src/styles/app.css](./src/renderer/src/styles/app.css):

- `@source` limits the scan to `src/renderer/src`, so the main process never leaks into the CSS.
- Design tokens live in the `:root` / `[data-theme='dark']` blocks and are exposed to Tailwind with
  `@theme inline`, which gives you `bg-surface`, `text-muted`, `border-line`, `text-danger` and
  friends.
- Theme switching is the `data-theme` attribute on `<html>`, set by `useSettings()` from the persisted
  settings. Utilities resolve through CSS variables, so no `dark:` variants are needed - add a new
  token to both blocks and it works everywhere.
- The CSP allows `style-src 'self' 'unsafe-inline'`, which is what Tailwind's dev-mode injection
  needs. Production builds emit one static CSS file instead.

## Security defaults

`contextIsolation: true`, `nodeIntegration: false`, a strict Content-Security-Policy in
[src/renderer/index.html](./src/renderer/index.html), and `setWindowOpenHandler` sending links to the
system browser. Keep secrets out of the renderer: anything prefixed `VITE_` ends up in the bundle.
See [.env.example](./.env.example).

## Packaging

Config lives in [electron-builder.yml](./electron-builder.yml) (app id `com.gemibot.prototype`, NSIS
installer, icons in `build/`). Build on the OS you target. Code signing and auto-updates are not
configured yet.

## Adding your own app

The three cards on the home screen exist to prove the IPC wiring works. Replace them with real
Gemibot screens under `src/renderer/src/pages/`, and add a matching `ipc/<domain>.handlers.ts` plus
`services/<domain>.service.ts` for anything that needs Node or the OS.
