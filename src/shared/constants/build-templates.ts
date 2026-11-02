export interface BuildTemplateContext {
  projectName: string
  goal: string
}

export interface BuildTemplateFile {
  path: string
  content: string
}

export interface BuildTemplate {
  id: string
  name: string
  summary: string
  /** A stack string from BUILD_TEMPLATE matching text. */
  match: RegExp
  files: (context: BuildTemplateContext) => BuildTemplateFile[]
}

function envExample(lines: string[]): string {
  return `${lines.join('\n')}\n`
}

function reactViteFiles(context: BuildTemplateContext): BuildTemplateFile[] {
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: context.projectName,
          private: true,
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'tsc --noEmit && vite build',
            preview: 'vite preview',
            typecheck: 'tsc --noEmit',
            test: 'vitest run'
          },
          dependencies: {
            react: '19.1.1',
            'react-dom': '19.1.1'
          },
          devDependencies: {
            '@types/react': '19.1.10',
            '@types/react-dom': '19.1.7',
            '@vitejs/plugin-react': '4.7.0',
            typescript: '5.9.2',
            vite: '7.1.2',
            vitest: '3.2.4'
          }
        },
        null,
        2
      )}\n`
    },
    {
      path: 'vite.config.ts',
      content: `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({ plugins: [react()] })\n`
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'Bundler',
            jsx: 'react-jsx',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ['vite/client'],
            allowImportingTsExtensions: false
          },
          include: ['src']
        },
        null,
        2
      )}\n`
    },
    {
      path: 'index.html',
      content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${context.projectName}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`
    },
    {
      path: 'src/main.tsx',
      content: `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App'\nimport './index.css'\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>\n)\n`
    },
    {
      path: 'src/App.tsx',
      content: `export default function App(): React.JSX.Element {\n  return (\n    <main>\n      <h1>${context.projectName}</h1>\n      <p>Scaffold ready. Features are added milestone by milestone.</p>\n    </main>\n  )\n}\n`
    },
    {
      path: 'src/index.css',
      content: `:root {\n  font-family: system-ui, -apple-system, Segoe UI, sans-serif;\n  color: #e2e8f0;\n  background: #0f172a;\n}\n\nbody {\n  margin: 0;\n}\n\nmain {\n  max-width: 860px;\n  margin: 0 auto;\n  padding: 48px 24px;\n}\n`
    },
    { path: '.env.example', content: envExample(['VITE_API_URL=http://localhost:3000']) },
    {
      path: '.gitignore',
      content: `node_modules/\ndist/\n.env\n.env.local\ncoverage/\n`
    }
  ]
}

function nodeExpressFiles(context: BuildTemplateContext): BuildTemplateFile[] {
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: context.projectName,
          private: true,
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'tsx watch src/server.ts',
            build: 'tsc -p tsconfig.json',
            start: 'node dist/server.js',
            typecheck: 'tsc --noEmit',
            test: 'vitest run'
          },
          dependencies: {
            express: '5.1.0'
          },
          devDependencies: {
            '@types/express': '5.0.3',
            '@types/node': '24.3.0',
            supertest: '7.1.4',
            '@types/supertest': '6.0.3',
            tsx: '4.20.3',
            typescript: '5.9.2',
            vitest: '3.2.4'
          }
        },
        null,
        2
      )}\n`
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            outDir: 'dist',
            rootDir: 'src',
            skipLibCheck: true,
            esModuleInterop: true,
            types: ['node']
          },
          include: ['src']
        },
        null,
        2
      )}\n`
    },
    {
      path: 'src/app.ts',
      content: `import express, { type Express } from 'express'\n\nexport function createApp(): Express {\n  const app = express()\n  app.use(express.json())\n\n  app.get('/health', (_request, response) => {\n    response.json({ status: 'ok' })\n  })\n\n  return app\n}\n`
    },
    {
      path: 'src/server.ts',
      content: `import { createApp } from './app.js'\n\nconst port = Number(process.env.PORT ?? 3000)\nconst app = createApp()\n\napp.listen(port, () => {\n  console.log(\`Server listening on http://localhost:\${port}\`)\n})\n`
    },
    {
      path: 'src/app.test.ts',
      content: `import { describe, expect, it } from 'vitest'\nimport request from 'supertest'\nimport { createApp } from './app.js'\n\ndescribe('health endpoint', () => {\n  it('reports ok', async () => {\n    const response = await request(createApp()).get('/health')\n    expect(response.status).toBe(200)\n    expect(response.body).toEqual({ status: 'ok' })\n  })\n})\n`
    },
    { path: '.env.example', content: envExample(['PORT=3000']) },
    {
      path: '.gitignore',
      content: `node_modules/\ndist/\n.env\ncoverage/\n`
    }
  ]
}

function fastapiFiles(context: BuildTemplateContext): BuildTemplateFile[] {
  const module = context.projectName.replaceAll('-', '_')
  return [
    {
      path: 'requirements.txt',
      content: `fastapi==0.116.1\nuvicorn[standard]==0.35.0\npydantic==2.11.7\npython-dotenv==1.1.1\npytest==8.4.1\nhttpx==0.28.1\n`
    },
    {
      path: 'app/__init__.py',
      content: `"""${context.projectName} application package."""\n`
    },
    {
      path: 'app/main.py',
      content: `import os\n\nfrom fastapi import FastAPI\n\napp = FastAPI(title=os.getenv("APP_NAME", "${context.projectName}"))\n\n\n@app.get("/health")\ndef health() -> dict[str, str]:\n    return {"status": "ok"}\n`
    },
    {
      path: 'tests/test_health.py',
      content: `from fastapi.testclient import TestClient\n\nfrom app.main import app\n\nclient = TestClient(app)\n\n\ndef test_health() -> None:\n    response = client.get("/health")\n    assert response.status_code == 200\n    assert response.json() == {"status": "ok"}\n`
    },
    {
      path: 'pyproject.toml',
      content: `[tool.pytest.ini_options]\npythonpath = ["."]\ntestpaths = ["tests"]\n`
    },
    { path: '.env.example', content: envExample(['APP_NAME=' + module]) },
    {
      path: '.gitignore',
      content: `__pycache__/\n.venv/\n.env\n.pytest_cache/\n*.pyc\n`
    }
  ]
}

function nextFiles(context: BuildTemplateContext): BuildTemplateFile[] {
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: context.projectName,
          private: true,
          version: '0.1.0',
          scripts: {
            dev: 'next dev',
            build: 'next build',
            start: 'next start',
            typecheck: 'tsc --noEmit'
          },
          dependencies: {
            next: '15.5.0',
            react: '19.1.1',
            'react-dom': '19.1.1'
          },
          devDependencies: {
            '@types/node': '24.3.0',
            '@types/react': '19.1.10',
            '@types/react-dom': '19.1.7',
            typescript: '5.9.2'
          }
        },
        null,
        2
      )}\n`
    },
    {
      path: 'next.config.mjs',
      content: `/** @type {import('next').NextConfig} */\nconst nextConfig = {}\n\nexport default nextConfig\n`
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['dom', 'dom.iterable', 'esnext'],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: 'preserve',
            incremental: true,
            plugins: [{ name: 'next' }],
            paths: { '@/*': ['./*'] }
          },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
          exclude: ['node_modules']
        },
        null,
        2
      )}\n`
    },
    {
      path: 'next-env.d.ts',
      content: `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`
    },
    {
      path: 'app/layout.tsx',
      content: `import type { Metadata } from 'next'\nimport './globals.css'\n\nexport const metadata: Metadata = { title: '${context.projectName}' }\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  )\n}\n`
    },
    {
      path: 'app/page.tsx',
      content: `export default function HomePage() {\n  return (\n    <main style={{ padding: 48 }}>\n      <h1>${context.projectName}</h1>\n      <p>Scaffold ready. Features are added milestone by milestone.</p>\n    </main>\n  )\n}\n`
    },
    { path: 'app/globals.css', content: `body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n` },
    { path: '.env.example', content: envExample(['NEXT_PUBLIC_API_URL=http://localhost:3000']) },
    {
      path: '.gitignore',
      content: `node_modules/\n.next/\n.env\n.env.local\nout/\n`
    }
  ]
}

function electronFiles(context: BuildTemplateContext): BuildTemplateFile[] {
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: context.projectName,
          private: true,
          version: '0.1.0',
          main: 'main.js',
          scripts: {
            start: 'electron .',
            test: 'node --test'
          },
          devDependencies: {
            electron: '37.2.6'
          }
        },
        null,
        2
      )}\n`
    },
    {
      path: 'main.js',
      content: `const { app, BrowserWindow } = require('electron')\nconst path = require('node:path')\n\nfunction createWindow() {\n  const window = new BrowserWindow({\n    width: 1024,\n    height: 720,\n    webPreferences: { preload: path.join(__dirname, 'preload.js') }\n  })\n  window.loadFile('index.html')\n}\n\napp.whenReady().then(() => {\n  createWindow()\n  app.on('activate', () => {\n    if (BrowserWindow.getAllWindows().length === 0) createWindow()\n  })\n})\n\napp.on('window-all-closed', () => {\n  if (process.platform !== 'darwin') app.quit()\n})\n`
    },
    {
      path: 'preload.js',
      content: `const { contextBridge } = require('electron')\n\ncontextBridge.exposeInMainWorld('app', { platform: process.platform })\n`
    },
    {
      path: 'renderer.js',
      content: `const root = document.getElementById('root')\nroot.textContent = '${context.projectName}'\n`
    },
    {
      path: 'index.html',
      content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>${context.projectName}</title>\n  </head>\n  <body>\n    <main id="root"></main>\n    <script src="./renderer.js"></script>\n  </body>\n</html>\n`
    },
    {
      path: 'main.test.js',
      content: `const { test } = require('node:test')\nconst assert = require('node:assert')\n\ntest('scaffold is sane', () => {\n  assert.ok(require('./package.json').main)\n})\n`
    },
    { path: '.env.example', content: envExample(['APP_ENV=development']) },
    {
      path: '.gitignore',
      content: `node_modules/\ndist/\n.env\n`
    }
  ]
}

export const BUILD_TEMPLATES: BuildTemplate[] = [
  {
    id: 'electron',
    name: 'Electron desktop app',
    summary: 'Electron main/preload/renderer shell with a node test.',
    match: /\belectron\b/iu,
    files: electronFiles
  },
  {
    id: 'next',
    name: 'Next.js app',
    summary: 'Next.js App Router with TypeScript and a minimal page.',
    match: /\bnext(?:\.js)?\b/iu,
    files: nextFiles
  },
  {
    id: 'react-vite',
    name: 'React + Vite',
    summary: 'React 19 + Vite + TypeScript + Vitest.',
    match: /\b(?:react|vite)\b/iu,
    files: reactViteFiles
  },
  {
    id: 'fastapi',
    name: 'Python + FastAPI',
    summary: 'FastAPI service with pytest and a health endpoint.',
    match: /\b(?:fastapi|python|django|flask)\b/iu,
    files: fastapiFiles
  },
  {
    id: 'node-express',
    name: 'Node + Express',
    summary: 'Express 5 service with TypeScript and Vitest.',
    match: /\b(?:express|node(?:\.js)?|rest\s*api)\b/iu,
    files: nodeExpressFiles
  }
]

export function findBuildTemplate(stackText: string): BuildTemplate | null {
  const text = stackText.toLowerCase()
  for (const template of BUILD_TEMPLATES) {
    if (template.match.test(text)) return template
  }
  return null
}

export function getBuildTemplate(id: string): BuildTemplate | null {
  return BUILD_TEMPLATES.find((template) => template.id === id) ?? null
}

export function projectNameFromGoal(goal: string): string {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word !== '' && !['a', 'an', 'the', 'me', 'my', 'build', 'create', 'make', 'simple', 'full'].includes(word))
  const name = words.slice(0, 3).join('-')
  return name === '' ? 'new-project' : name.slice(0, 40)
}
