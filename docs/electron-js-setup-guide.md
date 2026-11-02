# Electron JS Setup Guide: Desktop App Development

A step-by-step guide to going from nothing to a running, packaged Electron desktop app, followed by a professional project structure you can scale with. Commands work on Windows, macOS and Linux unless noted.

## Table of Contents

1. What You Need First
2. Create the Project Folder
3. Install Electron
4. Configure package.json
5. Understand the Two Process Types
6. Create the Project Files
7. Run the App
8. Debugging
9. Optional: Auto-Reload During Development
10. Package the App for Distribution
11. Starting With a Framework (Optional)
12. Recommended Security Practices
13. Common Problems and Fixes
14. Next Steps
15. Professional Project Structure

---

## 1. What You Need First

- **Node.js (LTS version)** and **npm**. Download from nodejs.org and install with the default options.
- **A code editor.** Visual Studio Code is the usual choice.
- **Git** (optional, but recommended).

Verify the install in a terminal (Command Prompt, PowerShell, or Terminal):

```bash
node -v
npm -v
```

Both commands should print a version number. If you get "command not found", close and reopen the terminal, or reinstall Node.js.

## 2. Create the Project Folder

```bash
mkdir my-electron-app
cd my-electron-app
npm init -y
```

`npm init -y` creates a `package.json` with default values.

## 3. Install Electron

Install Electron as a development dependency:

```bash
npm install --save-dev electron
```

Check that it worked:

```bash
npx electron --version
```

## 4. Configure package.json

Open `package.json` and make sure it has a `main` entry (the file Electron starts from) and a `start` script:

```json
{
  "name": "my-electron-app",
  "version": "1.0.0",
  "description": "My first Electron app",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^latest"
  }
}
```

Keep the exact Electron version number npm wrote into `devDependencies`; only change `main` and `scripts`.

## 5. Understand the Two Process Types

Electron apps have two kinds of processes. Knowing this prevents most beginner confusion.

- **Main process** (`main.js`): runs in Node.js. It creates windows, handles menus, files, and system features. There is exactly one.
- **Renderer process** (your HTML/CSS/JS pages): runs inside each window, like a web page. It should not have direct Node.js access for security reasons.
- **Preload script** (`preload.js`): a safe bridge between the two. It exposes only the functions you choose to the renderer.

## 6. Create the Project Files

Your structure will look like this:

```
my-electron-app/
  package.json
  main.js
  preload.js
  index.html
  renderer.js
  styles.css
```

### main.js

```javascript
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // keep renderer isolated (default, keep it on)
      nodeIntegration: false // do not give pages direct Node access
    }
  })

  win.loadFile('index.html')
}

// Example: respond to a message from the renderer
ipcMain.handle('get-app-version', () => app.getVersion())

app.whenReady().then(() => {
  createWindow()

  // macOS: re-create a window when the dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

### preload.js

```javascript
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version')
})
```

### index.html

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'" />
    <title>My Electron App</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <h1>Hello from Electron!</h1>
    <p>App version: <span id="version">...</span></p>
    <script src="renderer.js"></script>
  </body>
</html>
```

### renderer.js

```javascript
window.api.getAppVersion().then((v) => {
  document.getElementById('version').textContent = v
})
```

### styles.css

```css
body {
  font-family: system-ui, sans-serif;
  margin: 2rem;
}
```

## 7. Run the App

```bash
npm start
```

A desktop window should open showing "Hello from Electron!" and the app version. Press `Ctrl+R` (or `Cmd+R` on macOS) to reload the window after editing HTML/CSS/JS. Changes to `main.js` need a full restart.

## 8. Debugging

- **Renderer:** press `Ctrl+Shift+I` (`Cmd+Option+I` on macOS) to open Chrome DevTools, or add `win.webContents.openDevTools()` in `createWindow()`.
- **Main process:** use `console.log` (output appears in the terminal), or in VS Code create a launch configuration that runs `npm start` with the debugger attached.

## 9. Optional: Auto-Reload During Development

Install `electron-reloader`:

```bash
npm install --save-dev electron-reloader
```

Add this near the top of `main.js`:

```javascript
try {
  require('electron-reloader')(module)
} catch (_) {}
```

Now the app restarts automatically when you save files.

## 10. Package the App for Distribution

The recommended tool is **Electron Forge**, the official packaging toolkit.

### Add Forge to your existing project

```bash
npm install --save-dev @electron-forge/cli
npx electron-forge import
```

This adds Forge configuration and new scripts to `package.json`.

### Build

```bash
npm run make
```

The installers appear in the `out/` folder:

- **Windows:** a Squirrel installer (`.exe`)
- **macOS:** a `.zip` (and `.dmg` if configured)
- **Linux:** `.deb` and `.rpm`

Note: you generally need to build on the target operating system (build Windows installers on Windows, macOS installers on a Mac).

### Alternative: electron-builder

```bash
npm install --save-dev electron-builder
```

Add to `package.json`:

```json
"scripts": {
  "start": "electron .",
  "dist": "electron-builder"
}
```

Then run `npm run dist`.

## 11. Starting With a Framework (Optional)

If you plan to use React, Vue, or TypeScript, use a template instead of the manual setup:

```bash
npm init electron-app@latest my-app -- --template=vite
```

Other templates include `vite-typescript`, `webpack`, and `webpack-typescript`. This gives you a ready-made project with hot reload and packaging configured.

## 12. Recommended Security Practices

- Keep `contextIsolation: true` and `nodeIntegration: false`.
- Expose only specific functions through `contextBridge`, never raw `ipcRenderer`.
- Define a Content Security Policy in your HTML.
- Never load remote content with Node access enabled.
- Keep Electron updated, since each release includes Chromium security fixes.

## 13. Common Problems and Fixes

- **`electron` is not recognized:** run `npm install` again, and use `npm start` or `npx electron .` rather than calling `electron` directly.
- **Blank white window:** check the path in `loadFile`, and open DevTools to see errors.
- **`require is not defined` in the renderer:** this is expected with the secure setup. Move Node code to `main.js` and expose it through `preload.js`.
- **Electron download fails or is slow:** check your network or proxy, then retry `npm install`.
- **Packaged app works differently from dev:** use `path.join(__dirname, ...)` for file paths and avoid relying on the current working directory.

## 14. Next Steps

- Add a custom menu with `Menu.buildFromTemplate`.
- Use `dialog.showOpenDialog` to open files.
- Store data with `electron-store` or SQLite.
- Add auto-updates with `update-electron-app` or `electron-updater`.
- Read the official docs at electronjs.org/docs for the full API.

---

## 15. Professional Project Structure

The single-folder layout from Section 6 is fine for learning, but it does not scale. Real-world Electron apps are organized around one core idea: **keep the three runtime contexts (main, preload, renderer) in separate folders**, with a small shared area for code both sides need. This mirrors Electron's security model and keeps responsibilities clear.

### 15.1 Recommended Structure (TypeScript + Vite + React)

This is the layout most commonly seen in production apps, and it matches what `electron-vite` and Electron Forge's Vite-TypeScript template generate.

```
my-electron-app/
├── .github/
│   └── workflows/
│       └── release.yml            # CI: build and publish installers
├── build/                         # Build resources (not bundled into the app)
│   ├── icon.ico                   # Windows icon
│   ├── icon.icns                  # macOS icon
│   ├── icon.png                   # Linux icon
│   └── entitlements.mac.plist     # macOS signing entitlements
├── resources/                     # Static files shipped with the app
│   ├── images/
│   └── fonts/
├── scripts/                       # Helper scripts (notarize, version bump, etc.)
├── src/
│   ├── main/                      # MAIN PROCESS (Node.js)
│   │   ├── index.ts               # App entry: lifecycle, create window
│   │   ├── windows/
│   │   │   ├── main-window.ts     # Window creation and options
│   │   │   └── window-manager.ts  # Tracks and manages multiple windows
│   │   ├── ipc/
│   │   │   ├── index.ts           # Registers all IPC handlers
│   │   │   ├── file.handlers.ts   # File-related IPC handlers
│   │   │   └── settings.handlers.ts
│   │   ├── services/              # Business logic (no UI code)
│   │   │   ├── database.service.ts
│   │   │   ├── updater.service.ts
│   │   │   └── logger.service.ts
│   │   ├── menu/
│   │   │   ├── app-menu.ts
│   │   │   └── tray.ts
│   │   └── utils/
│   │       └── paths.ts
│   ├── preload/                   # PRELOAD (the secure bridge)
│   │   ├── index.ts               # contextBridge.exposeInMainWorld
│   │   └── index.d.ts             # Types for window.api
│   ├── renderer/                  # RENDERER (the UI, runs like a web app)
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx           # UI entry point
│   │       ├── App.tsx
│   │       ├── assets/            # Images, CSS imported by the UI
│   │       ├── components/        # Reusable UI components
│   │       ├── pages/             # Screens / routes
│   │       ├── hooks/             # Custom React hooks
│   │       ├── store/             # State management (Zustand, Redux, etc.)
│   │       ├── services/          # Calls to window.api, formatting, etc.
│   │       └── styles/
│   └── shared/                    # Code used by main, preload AND renderer
│       ├── constants/
│       │   └── ipc-channels.ts    # Single source of truth for channel names
│       ├── types/                 # Shared TypeScript interfaces
│       └── utils/
├── tests/
│   ├── unit/                      # Vitest / Jest
│   └── e2e/                       # Playwright
├── .env.example                   # Documented environment variables
├── .eslintrc.cjs                  # Linting rules
├── .gitignore
├── .prettierrc                    # Formatting rules
├── electron-builder.yml           # Or forge.config.ts: packaging config
├── electron.vite.config.ts        # Or vite.*.config.ts: bundler config
├── package.json
├── tsconfig.json                  # Base TypeScript config
├── tsconfig.node.json             # For main + preload
├── tsconfig.web.json              # For renderer
└── README.md
```

### 15.2 What Each Folder Is Responsible For

| Folder         | Runs in                | Responsibility                                                                               | Rule of thumb                                          |
| -------------- | ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `src/main`     | Main process (Node.js) | App lifecycle, windows, native menus, tray, file system, database, auto-update, IPC handlers | Anything that needs OS or Node access lives here       |
| `src/preload`  | Isolated bridge        | Exposes a small, typed API to the renderer through `contextBridge`                           | Keep it thin; no business logic                        |
| `src/renderer` | Chromium window        | UI, routing, state, user interaction                                                         | Treat it like a normal web app that has no Node access |
| `src/shared`   | All three              | IPC channel names, shared types, pure utility functions                                      | Must contain no Node-only or DOM-only code             |
| `build/`       | Build time             | Icons, signing entitlements, installer assets                                                | Not included in the running app                        |
| `resources/`   | Runtime                | Static assets bundled with the packaged app                                                  | Access via `process.resourcesPath` in production       |
| `scripts/`     | Build time             | Release and automation scripts                                                               | Called from `package.json` scripts or CI               |
| `tests/`       | Dev/CI                 | Unit and end-to-end tests                                                                    | Keep e2e tests separate from unit tests                |

### 15.3 Layered Architecture Inside the Main Process

For larger apps, organize the main process in layers so logic stays testable and the window code stays small:

```
IPC handlers  →  Services  →  Repositories / Data access
(ipc/)           (services/)   (db/ or repositories/)
```

- **IPC handlers** only validate input and call a service. They contain no business logic.
- **Services** hold the real logic (for example, `OrderService`, `UpdaterService`) and know nothing about windows or IPC.
- **Repositories** talk to the database, files, or external APIs.

This separation lets you unit test services without launching Electron.

### 15.4 Centralize IPC Channel Names

Avoid magic strings scattered across files. Define channels once in `src/shared`:

```typescript
// src/shared/constants/ipc-channels.ts
export const IPC = {
  APP: {
    GET_VERSION: 'app:get-version'
  },
  FILE: {
    OPEN_DIALOG: 'file:open-dialog',
    READ: 'file:read'
  },
  SETTINGS: {
    GET: 'settings:get',
    SET: 'settings:set'
  }
} as const
```

Use the same constant in the handler, the preload script, and any tests.

### 15.5 Typed Preload API

```typescript
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants/ipc-channels'

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP.GET_VERSION),
  openFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.FILE.OPEN_DIALOG)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
```

```typescript
// src/preload/index.d.ts
import type { Api } from './index'

declare global {
  interface Window {
    api: Api
  }
}
```

Now `window.api.getVersion()` is fully type-checked in the renderer.

### 15.6 Simpler Structure for Plain JavaScript Apps

If you are not using TypeScript or a UI framework, a clean and still professional layout is:

```
my-electron-app/
├── src/
│   ├── main/
│   │   ├── index.js
│   │   ├── ipc/
│   │   └── services/
│   ├── preload/
│   │   └── index.js
│   ├── renderer/
│   │   ├── index.html
│   │   ├── renderer.js
│   │   ├── components/
│   │   └── styles/
│   └── shared/
│       └── ipc-channels.js
├── resources/
├── build/
├── package.json
└── README.md
```

Set `"main": "src/main/index.js"` in `package.json`.

### 15.7 Key Configuration Files

- **`package.json`**: set `main` to your built main entry, define scripts such as `dev`, `build`, `make`/`dist`, `lint`, and `test`.
- **`electron.vite.config.ts` or `forge.config.ts`**: bundler and packaging setup for main, preload, and renderer.
- **`electron-builder.yml`**: app ID, product name, icons, installer targets, and auto-update publishing.
- **`tsconfig*.json`**: separate configs for Node-side code (main + preload) and browser-side code (renderer).
- **`.env.example`**: documents required environment variables without exposing secrets.
- **`.eslintrc` and `.prettierrc`**: consistent code style across the team.

### 15.8 Recommended Scripts

```json
"scripts": {
  "dev": "electron-vite dev",
  "build": "electron-vite build",
  "preview": "electron-vite preview",
  "dist": "npm run build && electron-builder",
  "lint": "eslint .",
  "format": "prettier --write .",
  "test": "vitest",
  "test:e2e": "playwright test"
}
```

### 15.9 Conventions Used by Professional Teams

- **One responsibility per file.** For example, `file.handlers.ts` handles only file-related IPC.
- **Consistent naming.** Use `kebab-case` for files, `PascalCase` for classes and React components, and `namespace:action` for IPC channels.
- **Never import Node or Electron modules in the renderer.** Everything goes through the preload API.
- **Validate all IPC input in the main process.** Treat the renderer as untrusted.
- **Keep secrets out of the renderer.** API keys and tokens stay in the main process.
- **Use a logger** (such as `electron-log`) instead of scattered `console.log` calls, so logs persist to disk in production.
- **Separate dev and production paths.** Use `app.isPackaged` to switch between a dev server URL and the built `index.html`.
- **Automate releases.** Use a CI workflow to build, sign, and publish installers on every tagged release.

### 15.10 Quick Way to Get This Structure

Instead of building it by hand, generate it:

```bash
# Option 1: electron-vite (React, Vue, Svelte, or vanilla, with TypeScript)
npm create @quick-start/electron@latest my-app

# Option 2: Electron Forge with the Vite + TypeScript template
npm init electron-app@latest my-app -- --template=vite-typescript
```

Both give you the main/preload/renderer separation out of the box, and you can then add the `ipc/`, `services/`, `shared/`, and `tests/` folders described above as your app grows.
