import { describe, expect, it } from 'vitest'

import {
  BUILD_TEMPLATES,
  findBuildTemplate,
  getBuildTemplate,
  projectNameFromGoal
} from '../../src/shared/constants/build-templates'

const context = { projectName: 'inventory-app', goal: 'Build an inventory app' }

function fileMap(templateId: string): Map<string, string> {
  const template = getBuildTemplate(templateId)
  expect(template).not.toBeNull()
  return new Map((template?.files(context) ?? []).map((file) => [file.path, file.content]))
}

describe('findBuildTemplate', () => {
  it('matches by stack keywords', () => {
    expect(findBuildTemplate('React 19 with Vite and TypeScript')?.id).toBe('react-vite')
    expect(findBuildTemplate('Next.js App Router')?.id).toBe('next')
    expect(findBuildTemplate('Electron desktop application')?.id).toBe('electron')
    expect(findBuildTemplate('Node.js Express API')?.id).toBe('node-express')
    expect(findBuildTemplate('Python FastAPI service')?.id).toBe('fastapi')
  })

  it('prefers the more specific template when several match', () => {
    expect(findBuildTemplate('Electron app with React')?.id).toBe('electron')
    expect(findBuildTemplate('Next.js frontend with an Express API')?.id).toBe('next')
    expect(findBuildTemplate('Python FastAPI REST API backend')?.id).toBe('fastapi')
  })

  it('returns null when nothing matches', () => {
    expect(findBuildTemplate('plain SQLite schema with no framework')).toBeNull()
    expect(findBuildTemplate('')).toBeNull()
  })
})

describe('getBuildTemplate', () => {
  it('returns every registered template by id', () => {
    for (const template of BUILD_TEMPLATES) {
      expect(getBuildTemplate(template.id)).toBe(template)
    }
    expect(getBuildTemplate('missing')).toBeNull()
  })
})

describe('template files', () => {
  it('ships pinned dependencies and a build/test path for every template', () => {
    for (const template of BUILD_TEMPLATES) {
      const files = template.files(context)
      const paths = files.map((file) => file.path)
      expect(paths).toContain('.env.example')
      expect(paths).toContain('.gitignore')
      expect(paths.every((path) => !path.startsWith('/') && !path.includes('..'))).toBe(true)
      for (const file of files) {
        expect(file.content).not.toContain('GEMINI_API_KEY')
        expect(file.content).not.toMatch(/api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{10,}/iu)
      }
    }

    const react = JSON.parse(fileMap('react-vite').get('package.json') ?? '{}') as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(react.dependencies.react).toBe('19.1.1')
    expect(react.dependencies['react-dom']).toBe('19.1.1')
    expect(react.devDependencies.vite).toBe('7.1.2')

    const express = JSON.parse(fileMap('node-express').get('package.json') ?? '{}') as {
      dependencies: Record<string, string>
    }
    expect(express.dependencies.express).toBe('5.1.0')

    const next = JSON.parse(fileMap('next').get('package.json') ?? '{}') as {
      dependencies: Record<string, string>
    }
    expect(next.dependencies.next).toBe('15.5.0')

    const python = fileMap('fastapi').get('requirements.txt') ?? ''
    expect(python).toContain('fastapi==0.116.1')
    expect(python.trim().split('\n').every((line) => line.includes('=='))).toBe(true)
  })

  it('includes the files each template needs to start and test', () => {
    expect([...fileMap('react-vite').keys()]).toEqual(
      expect.arrayContaining(['src/main.tsx', 'src/App.tsx', 'vite.config.ts', 'tsconfig.json'])
    )
    expect([...fileMap('node-express').keys()]).toEqual(
      expect.arrayContaining(['src/app.ts', 'src/server.ts', 'src/app.test.ts'])
    )
    expect([...fileMap('fastapi').keys()]).toEqual(
      expect.arrayContaining(['app/main.py', 'tests/test_health.py', 'pyproject.toml'])
    )
    expect([...fileMap('next').keys()]).toEqual(
      expect.arrayContaining(['app/layout.tsx', 'app/page.tsx'])
    )
    expect([...fileMap('electron').keys()]).toEqual(
      expect.arrayContaining(['main.js', 'preload.js', 'renderer.js', 'main.test.js'])
    )
  })

  it('puts the sanitized project name into generated content', () => {
    expect(fileMap('fastapi').get('app/main.py')).toContain('inventory-app')
    expect(fileMap('react-vite').get('index.html')).toContain('<title>inventory-app</title>')
    expect(fileMap('react-vite').get('src/App.tsx')).toContain('inventory-app')
  })
})

describe('projectNameFromGoal', () => {
  it('creates a short kebab-case package name', () => {
    expect(projectNameFromGoal('Build me a simple full-stack inventory manager')).toBe(
      'full-stack-inventory-manager'
    )
    expect(projectNameFromGoal('Create a REST API inventory service')).toBe('rest-api-inventory')
    expect(projectNameFromGoal('Make todo app auth')).toBe('todo-app-auth')
  })

  it('strips punctuation and falls back when nothing remains', () => {
    expect(projectNameFromGoal('Build a "cool" app!!!')).toBe('cool-app')
    expect(projectNameFromGoal('build create make')).toBe('new-project')
    expect(projectNameFromGoal('')).toBe('new-project')
  })

  it('bounds the name length and word count', () => {
    const name = projectNameFromGoal(
      'Create an extremely-long-inventory-management-platform-with-many-words'
    )
    expect(name.length).toBeLessThanOrEqual(40)
    expect(projectNameFromGoal('Build one two three four five')).toBe('one-two-three')
    expect(projectNameFromGoal('Create one extremely long inventory platform')).toBe(
      'one-extremely-long'
    )
  })
})
