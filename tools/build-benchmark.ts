import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve, sep } from 'path'

import { BuildDocsService } from '../src/main/services/build-docs.service'
import type {
  BuildModelCall,
  BuildModelResult,
  BuildModelService,
  BuildTextCall,
  BuildUsageCounts
} from '../src/main/services/build-model.service'
import {
  BuildOrchestrator,
  type BuildTaskRunnerInput,
  type BuildTaskRunnerResult
} from '../src/main/services/build-orchestrator.service'
import { BuildRepoMapService } from '../src/main/services/build-repo-map.service'
import type { BuildRepository } from '../src/main/services/build-repository.service'
import type {
  BuildVerifier,
  BuildVerifyOptions
} from '../src/main/services/build-verifier.service'
import { buildAgentPrompt } from '../src/shared/prompts/system-prompt'
import type {
  BuildArchitecture,
  BuildPlan,
  BuildRunStatus,
  BuildSpec,
  BuildVerification,
  BuildVerifyKind,
  BuildVerifyStep
} from '../src/shared/types/build'
import type {
  BuildRepairResult,
  BuildReviewResult
} from '../src/shared/utils/build-validate'
import { normalizeBuildSettings } from '../src/shared/utils/build-settings'

/**
 * Four-scenario Build mode benchmark. Fake mode is fully offline: a scripted model plays the
 * provider, a scripted verifier plays install/build/test/smoke, and the orchestrator runs the
 * real pipeline against a temporary folder. No API key, network or real project data is used.
 *
 * The normal-mode figure is an estimate, not an API measurement: it models one tool turn per
 * file with every previously written file still in context. It is a lower bound because it
 * omits reads, tool-call overhead and verification turns.
 */

interface ScenarioFile {
  path: string
  content: string
}

export interface BenchmarkScenario {
  id: string
  name: string
  goal: string
  spec: BuildSpec
  architecture: BuildArchitecture
  plan: BuildPlan
  scaffold: ScenarioFile[]
  taskFiles: Record<string, ScenarioFile[]>
  review: BuildReviewResult
  repair?: BuildRepairResult
  verifications: BuildVerification[]
  verifyEachMilestone?: boolean
  retryTask?: string
  readme: string
}

export interface ScenarioMetrics {
  id: string
  name: string
  status: BuildRunStatus
  success: boolean
  durationMs: number
  filesCreated: number
  tasks: number
  tasksSucceeded: number
  verifications: number
  commands: number
  builds: number
  tests: number
  smoke: number
  taskRetries: number
  repairs: number
  steps: number
  tokens: {
    input: number
    output: number
    task: number
    total: number
  }
  normalModeEstimate: {
    input: number
    output: number
    total: number
    turns: number
  }
  notes: string[]
}

export interface BenchmarkReport {
  generatedAt: string
  mode: 'fake'
  caveat: string
  scenarios: ScenarioMetrics[]
  totals: {
    scenarios: number
    succeeded: number
    durationMs: number
    tokens: number
    normalModeEstimate: number
    repairs: number
    taskRetries: number
    filesCreated: number
  }
}

const ALL_KINDS: BuildVerifyKind[] = ['install', 'build', 'typecheck', 'lint', 'test', 'smoke']

const COMMANDS: Record<BuildVerifyKind, string> = {
  install: 'npm install',
  build: 'npm run build',
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  test: 'npm test',
  smoke: 'http check /'
}

function steps(failing?: BuildVerifyKind): BuildVerifyStep[] {
  return ALL_KINDS.map((kind) => ({
    kind,
    command: COMMANDS[kind],
    status: failing === kind ? 'failed' : 'success',
    exitCode: failing === kind ? 2 : 0,
    output: failing === kind ? `TypeError: broken in src/App.tsx` : 'ok',
    durationMs: 10
  }))
}

function verification(failing?: BuildVerifyKind): BuildVerification {
  const list = steps(failing)
  return {
    steps: list,
    passed: failing === undefined,
    summary: `Simulated verification — ${list.filter((step) => step.status === 'failed').length} failed`
  }
}

const PASS = verification()
const FAIL_BUILD = verification('build')

const TODO: BenchmarkScenario = {
  id: 'todo-web',
  name: 'Todo web app',
  goal: 'Build a production-ready todo web app with add, complete and delete actions, filters, local persistence and a responsive interface.',
  spec: {
    goal: 'A responsive single-page todo app with persistent local state',
    users: ['Individual task owners'],
    features: ['Add, complete and delete todos', 'Filter all/active/completed', 'Persist to localStorage', 'Responsive layout'],
    stack: ['React', 'Vite', 'TypeScript'],
    dataModel: ['Todo(id, title, completed, createdAt)'],
    surfaces: ['Main todo view'],
    outOfScope: ['Accounts and sync'],
    assumptions: ['Single browser, no backend'],
    clarifyQuestions: []
  },
  architecture: {
    summary: 'Small React client with a pure todo store and a thin view layer',
    folders: [{ path: 'src/features', purpose: 'Todo domain and view helpers' }],
    modules: [
      { name: 'todos', path: 'src/features/todos', responsibility: 'Todo state transitions', dependsOn: [] },
      { name: 'todo-view', path: 'src/features/todo-view', responsibility: 'Filtering and rendering data', dependsOn: ['todos'] }
    ],
    contracts: [
      { kind: 'type', name: 'Todo', signature: 'type Todo = { id: string; title: string; completed: boolean }', notes: '' },
      { kind: 'function', name: 'addTodo', signature: 'addTodo(todos: Todo[], title: string): Todo[]', notes: '' }
    ],
    schema: ['localStorage key: gemibot.todos'],
    conventions: ['Strict TypeScript', 'Pure reducers'],
    sharedFiles: []
  },
  plan: {
    summary: 'Build the todo state and view helpers in one milestone',
    milestones: [
      {
        id: 'm1',
        title: 'Todo core',
        goal: 'Implement the todo state machine and view data',
        acceptance: ['Todos can be added, completed and removed', 'Filters return the right rows'],
        tasks: [
          {
            id: 't1',
            title: 'Todo state',
            description: 'Implement immutable todo operations and localStorage serialization',
            files: ['src/features/todos.ts'],
            acceptance: ['Adding, completing and deleting update state'],
            dependsOn: []
          },
          {
            id: 't2',
            title: 'Todo view helpers',
            description: 'Implement filtering and summary counters for the UI',
            files: ['src/features/todo-view.ts'],
            acceptance: ['active/completed filters match the store'],
            dependsOn: ['t1']
          }
        ]
      }
    ],
    verification: ['npm run typecheck', 'npm test'],
    risks: ['localStorage quota on very large lists']
  },
  scaffold: [],
  taskFiles: {
    t1: [
      {
        path: 'src/features/todos.ts',
        content: [
          'export interface Todo { id: string; title: string; completed: boolean }',
          '',
          'export function addTodo(todos: Todo[], title: string): Todo[] {',
          '  const clean = title.trim()',
          '  if (clean === "") return todos',
          '  return [...todos, { id: crypto.randomUUID(), title: clean, completed: false }]',
          '}',
          '',
          'export function toggleTodo(todos: Todo[], id: string): Todo[] {',
          '  return todos.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo))',
          '}',
          '',
          'export function deleteTodo(todos: Todo[], id: string): Todo[] {',
          '  return todos.filter((todo) => todo.id !== id)',
          '}',
          '',
          'export function saveTodos(todos: Todo[]): void {',
          '  localStorage.setItem("gemibot.todos", JSON.stringify(todos))',
          '}',
          '',
          'export function loadTodos(): Todo[] {',
          '  try {',
          '    const raw = localStorage.getItem("gemibot.todos")',
          '    return raw === null ? [] : (JSON.parse(raw) as Todo[])',
          '  } catch {',
          '    return []',
          '  }',
          '}',
          ''
        ].join('\n')
      }
    ],
    t2: [
      {
        path: 'src/features/todo-view.ts',
        content: [
          'import type { Todo } from "./todos"',
          '',
          'export type TodoFilter = "all" | "active" | "completed"',
          '',
          'export function filterTodos(todos: Todo[], filter: TodoFilter): Todo[] {',
          '  if (filter === "active") return todos.filter((todo) => !todo.completed)',
          '  if (filter === "completed") return todos.filter((todo) => todo.completed)',
          '  return todos',
          '}',
          '',
          'export function todoSummary(todos: Todo[]): string {',
          '  const done = todos.filter((todo) => todo.completed).length',
          '  return `${done}/${todos.length} complete`',
          '}',
          ''
        ].join('\n')
      }
    ]
  },
  review: { passed: true, issues: [] },
  verifications: [PASS, PASS],
  readme: '# Todo app\n\nAdd, complete and filter todos. State stays in localStorage.\n'
}

const REST_AUTH: BenchmarkScenario = {
  id: 'rest-auth',
  name: 'REST API auth',
  goal: 'Build a REST API with JWT authentication, registration, login, protected routes, request validation and a small test suite.',
  spec: {
    goal: 'A small authenticated REST API with hashed passwords and signed tokens',
    users: ['API consumers'],
    features: ['Register', 'Login', 'Protected profile route', 'Input validation', 'Auth tests'],
    stack: ['Express', 'TypeScript', 'SQLite'],
    dataModel: ['User(id, email, passwordHash, createdAt)'],
    surfaces: ['POST /auth/register', 'POST /auth/login', 'GET /me'],
    outOfScope: ['Refresh tokens', 'OAuth providers'],
    assumptions: ['JWT secret comes from the environment'],
    clarifyQuestions: []
  },
  architecture: {
    summary: 'Express service with an auth domain module and thin routes',
    folders: [{ path: 'src', purpose: 'Server code' }],
    modules: [
      { name: 'auth', path: 'src/auth', responsibility: 'Hashing, tokens and validation', dependsOn: [] },
      { name: 'auth-routes', path: 'src/routes/auth', responsibility: 'HTTP handlers', dependsOn: ['auth'] }
    ],
    contracts: [
      { kind: 'route', name: 'register', signature: 'POST /auth/register { email, password } -> 201', notes: 'reject duplicates' },
      { kind: 'function', name: 'hashPassword', signature: 'hashPassword(plain: string): Promise<string>', notes: '' }
    ],
    schema: ['users(id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT)'],
    conventions: ['Async handlers with explicit errors'],
    sharedFiles: []
  },
  plan: {
    summary: 'Implement the auth domain, then the routes',
    milestones: [
      {
        id: 'm1',
        title: 'Auth API',
        goal: 'Registration, login and the protected profile route',
        acceptance: ['Bad passwords are rejected', 'Valid tokens reach /me'],
        tasks: [
          {
            id: 't1',
            title: 'Auth domain',
            description: 'Implement hashing, token signing and request validation',
            files: ['src/auth.ts'],
            acceptance: ['hashPassword and verifyPassword round-trip'],
            dependsOn: []
          },
          {
            id: 't2',
            title: 'Auth routes',
            description: 'Wire register, login and profile routes to the domain',
            files: ['src/routes/auth.ts'],
            acceptance: ['Routes return 201/200/401 correctly'],
            dependsOn: ['t1']
          }
        ]
      }
    ],
    verification: ['npm test'],
    risks: ['JWT secret missing in production']
  },
  scaffold: [],
  taskFiles: {
    t1: [
      {
        path: 'src/auth.ts',
        content: [
          'import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto"',
          '',
          'export function hashPassword(plain: string): string {',
          '  const salt = randomBytes(16).toString("hex")',
          '  const hash = scryptSync(plain, salt, 64).toString("hex")',
          '  return `${salt}:${hash}`',
          '}',
          '',
          'export function verifyPassword(plain: string, stored: string): boolean {',
          '  const [salt, hash] = stored.split(":")',
          '  if (salt === undefined || hash === undefined) return false',
          '  const candidate = scryptSync(plain, salt, 64)',
          '  const expected = Buffer.from(hash, "hex")',
          '  return candidate.length === expected.length && timingSafeEqual(candidate, expected)',
          '}',
          '',
          'export function signToken(email: string, secret: string): string {',
          '  const payload = Buffer.from(JSON.stringify({ email, iat: Date.now() })).toString("base64url")',
          '  const signature = createHmac("sha256", secret).update(payload).digest("base64url")',
          '  return `${payload}.${signature}`',
          '}',
          '',
          'export function validCredentials(body: unknown): { email: string; password: string } | null {',
          '  if (body === null || typeof body !== "object") return null',
          '  const data = body as Record<string, unknown>',
          '  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : ""',
          '  const password = typeof data.password === "string" ? data.password : ""',
          '  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email) || password.length < 8) return null',
          '  return { email, password }',
          '}',
          ''
        ].join('\n')
      }
    ],
    t2: [
      {
        path: 'src/routes/auth.ts',
        content: [
          'import { Router } from "express"',
          'import { hashPassword, signToken, validCredentials, verifyPassword } from "../auth"',
          '',
          'interface UserRow { email: string; password_hash: string }',
          '',
          'export function authRoutes(users: Map<string, UserRow>, secret: string): Router {',
          '  const router = Router()',
          '  router.post("/auth/register", (request, response) => {',
          '    const input = validCredentials(request.body)',
          '    if (input === null) return response.status(400).json({ error: "invalid input" })',
          '    if (users.has(input.email)) return response.status(409).json({ error: "exists" })',
          '    users.set(input.email, { email: input.email, password_hash: hashPassword(input.password) })',
          '    return response.status(201).json({ email: input.email })',
          '  })',
          '  router.post("/auth/login", (request, response) => {',
          '    const input = validCredentials(request.body)',
          '    const user = input === null ? undefined : users.get(input.email)',
          '    if (input === null || user === undefined || !verifyPassword(input.password, user.password_hash)) {',
          '      return response.status(401).json({ error: "invalid credentials" })',
          '    }',
          '    return response.json({ token: signToken(user.email, secret) })',
          '  })',
          '  return router',
          '}',
          ''
        ].join('\n')
      }
    ]
  },
  review: { passed: true, issues: [] },
  verifications: [PASS, PASS],
  retryTask: 't1',
  readme: '# Auth API\n\nRegister, log in and call protected routes with the returned token.\n'
}

const INVENTORY: BenchmarkScenario = {
  id: 'inventory-fullstack',
  name: 'Full-stack inventory',
  goal: 'Build a full-stack inventory manager with a React dashboard, an Express API, SQLite storage, low-stock alerts and CSV export.',
  spec: {
    goal: 'Track stock per warehouse with alerts and CSV export',
    users: ['Warehouse staff', 'Store manager'],
    features: ['Stock list and adjustments', 'Low-stock alerts', 'CSV export', 'Dashboard summary'],
    stack: ['React', 'Express', 'SQLite'],
    dataModel: ['Item(id, name, quantity, threshold)', 'Warehouse(id, name)'],
    surfaces: ['Dashboard', 'GET /api/items', 'GET /api/items/export'],
    outOfScope: ['Purchasing and invoices'],
    assumptions: ['Single tenant', 'SQLite file lives next to the server'],
    clarifyQuestions: []
  },
  architecture: {
    summary: 'React dashboard against an Express API with a small inventory domain',
    folders: [
      { path: 'src/features', purpose: 'Client domain helpers' },
      { path: 'src/server', purpose: 'API and storage' }
    ],
    modules: [
      { name: 'inventory', path: 'src/features/inventory', responsibility: 'Stock math and alerts', dependsOn: [] },
      { name: 'csv', path: 'src/features/csv', responsibility: 'CSV serialization', dependsOn: [] },
      { name: 'dashboard', path: 'src/features/dashboard', responsibility: 'Dashboard aggregation', dependsOn: ['inventory'] }
    ],
    contracts: [
      { kind: 'type', name: 'Item', signature: 'type Item = { id: string; name: string; quantity: number; threshold: number }', notes: '' },
      { kind: 'function', name: 'lowStock', signature: 'lowStock(items: Item[]): Item[]', notes: '' }
    ],
    schema: ['items(id TEXT PRIMARY KEY, name TEXT, quantity INTEGER, threshold INTEGER)'],
    conventions: ['Pinned dependencies', 'No secrets in source'],
    sharedFiles: []
  },
  plan: {
    summary: 'Data helpers first, then the dashboard aggregation',
    milestones: [
      {
        id: 'm1',
        title: 'Inventory data',
        goal: 'Stock transitions, alerts and CSV output',
        acceptance: ['Low-stock list is correct', 'CSV escapes commas'],
        tasks: [
          {
            id: 't1',
            title: 'Stock domain',
            description: 'Implement stock adjustments and low-stock detection',
            files: ['src/features/inventory.ts'],
            acceptance: ['Quantities never go below zero'],
            dependsOn: []
          },
          {
            id: 't2',
            title: 'CSV export',
            description: 'Serialize item rows with proper escaping',
            files: ['src/features/csv.ts'],
            acceptance: ['Commas and quotes are escaped'],
            dependsOn: []
          }
        ]
      },
      {
        id: 'm2',
        title: 'Dashboard',
        goal: 'Aggregate stock for the dashboard cards',
        acceptance: ['Totals match the item list'],
        tasks: [
          {
            id: 't3',
            title: 'Dashboard summary',
            description: 'Compute total units, item count and alert count',
            files: ['src/features/dashboard.ts'],
            acceptance: ['Counts handle an empty list'],
            dependsOn: ['t1']
          }
        ]
      }
    ],
    verification: ['npm run build', 'npm test'],
    risks: ['Large CSVs block the UI thread']
  },
  scaffold: [],
  taskFiles: {
    t1: [
      {
        path: 'src/features/inventory.ts',
        content: [
          'export interface Item { id: string; name: string; quantity: number; threshold: number }',
          '',
          'export function adjust(item: Item, delta: number): Item {',
          '  return { ...item, quantity: Math.max(0, item.quantity + delta) }',
          '}',
          '',
          'export function lowStock(items: Item[]): Item[] {',
          '  return items.filter((item) => item.quantity <= item.threshold)',
          '}',
          ''
        ].join('\n')
      }
    ],
    t2: [
      {
        path: 'src/features/csv.ts',
        content: [
          'import type { Item } from "./inventory"',
          '',
          'function cell(value: string): string {',
          '  return /[",\\n]/.test(value) ? `"${value.replaceAll(\'"\', \'""\')}"` : value',
          '}',
          '',
          'export function itemsToCsv(items: Item[]): string {',
          '  const rows = [["id", "name", "quantity", "threshold"]]',
          '  for (const item of items) rows.push([item.id, cell(item.name), String(item.quantity), String(item.threshold)])',
          '  return rows.map((row) => row.join(",")).join("\\n")',
          '}',
          ''
        ].join('\n')
      }
    ],
    t3: [
      {
        path: 'src/features/dashboard.ts',
        content: [
          'import { lowStock, type Item } from "./inventory"',
          '',
          'export interface Summary { items: number; units: number; alerts: number }',
          '',
          'export function summarize(items: Item[]): Summary {',
          '  return {',
          '    items: items.length,',
          '    units: items.reduce((total, item) => total + item.quantity, 0),',
          '    alerts: lowStock(items).length',
          '  }',
          '}',
          ''
        ].join('\n')
      }
    ]
  },
  review: { passed: true, issues: [] },
  repair: {
    diagnosis: 'The final page still shows the scaffold placeholder',
    edits: [
      {
        path: 'src/App.tsx',
        search: 'Scaffold ready.',
        replace: 'Scaffold verified by the repair loop.'
      }
    ],
    creates: [],
    deletes: []
  },
  verifications: [PASS, PASS, PASS, FAIL_BUILD, PASS],
  verifyEachMilestone: true,
  readme: '# Inventory manager\n\nTrack stock, watch low-stock alerts and export CSV.\n'
}

const VAGUE: BenchmarkScenario = {
  id: 'vague-request',
  name: 'Vague request',
  goal: 'build me something for my shop',
  spec: {
    goal: 'A minimal shop stock list that records products and quantities',
    users: ['Shop owner'],
    features: ['List products', 'Add a product with quantity', 'Flag low stock'],
    stack: ['TypeScript'],
    dataModel: ['Product(id, name, quantity, threshold)'],
    surfaces: ['Single product list'],
    outOfScope: ['Payments', 'Online storefront'],
    assumptions: ['Small retail shop with one admin', 'Data stays in the browser', 'English UI'],
    clarifyQuestions: ['Should the shop manage online orders or only in-store stock?']
  },
  architecture: {
    summary: 'One TypeScript module for product state, rendered by a small page later',
    folders: [{ path: 'src', purpose: 'Shop module' }],
    modules: [
      { name: 'shop', path: 'src/shop', responsibility: 'Product list and low-stock rules', dependsOn: [] }
    ],
    contracts: [
      { kind: 'type', name: 'Product', signature: 'type Product = { id: string; name: string; quantity: number; threshold: number }', notes: '' }
    ],
    schema: ['in-memory product list'],
    conventions: ['Strict TypeScript'],
    sharedFiles: []
  },
  plan: {
    summary: 'One small milestone that delivers the stock list',
    milestones: [
      {
        id: 'm1',
        title: 'Shop stock',
        goal: 'List and add products',
        acceptance: ['Products can be added and low stock is flagged'],
        tasks: [
          {
            id: 't1',
            title: 'Stock module',
            description: 'Implement add, remove and low-stock helpers',
            files: ['src/shop.ts'],
            acceptance: ['Adds and removes products by id'],
            dependsOn: []
          }
        ]
      }
    ],
    verification: ['npm run typecheck'],
    risks: ['Ambiguous scope; assumptions are recorded']
  },
  scaffold: [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: 'shop-stock',
          private: true,
          version: '0.1.0',
          scripts: {
            build: 'tsc -p tsconfig.json',
            typecheck: 'tsc --noEmit',
            test: 'node --test'
          },
          devDependencies: { typescript: '5.9.2' }
        },
        null,
        2
      )}\n`
    },
    {
      path: 'tsconfig.json',
      content: '{\n  "compilerOptions": { "target": "ES2022", "module": "ESNext", "strict": true, "noEmit": true },\n  "include": ["src"]\n}\n'
    },
    { path: 'src/index.ts', content: 'export {}\n' },
    { path: '.env.example', content: '# No secrets required\n' },
    { path: '.gitignore', content: 'node_modules/\ndist/\n.env\n' }
  ],
  taskFiles: {
    t1: [
      {
        path: 'src/shop.ts',
        content: [
          'export interface Product { id: string; name: string; quantity: number; threshold: number }',
          '',
          'export function addProduct(products: Product[], name: string, quantity: number): Product[] {',
          '  const clean = name.trim()',
          '  if (clean === "") return products',
          '  return [...products, { id: crypto.randomUUID(), name: clean, quantity: Math.max(0, quantity), threshold: 2 }]',
          '}',
          '',
          'export function removeProduct(products: Product[], id: string): Product[] {',
          '  return products.filter((product) => product.id !== id)',
          '}',
          '',
          'export function lowStock(products: Product[]): Product[] {',
          '  return products.filter((product) => product.quantity <= product.threshold)',
          '}',
          ''
        ].join('\n')
      }
    ]
  },
  review: { passed: true, issues: [] },
  verifications: [PASS, PASS],
  readme: '# Shop stock\n\nA small stock list with low-stock flags. Assumptions are recorded in SPEC.md.\n'
}

export const SCENARIOS: BenchmarkScenario[] = [TODO, REST_AUTH, INVENTORY, VAGUE]

function estimate(text: string): number {
  return Math.ceil(text.length / 4)
}

function usageFor(system: string, prompt: string, output: string): BuildUsageCounts {
  const inputTokens = estimate(`${system}${prompt}`)
  const outputTokens = estimate(output)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

class ScriptedModels {
  private readonly scenario: BenchmarkScenario
  readonly calls: Array<{ stage: string; input: number; output: number }> = []

  constructor(scenario: BenchmarkScenario) {
    this.scenario = scenario
  }

  roleModel(role: 'strong' | 'implementation' | 'cheap'): string {
    return `bench-${role}`
  }

  async json<T>(call: BuildModelCall<T>): Promise<BuildModelResult<T>> {
    let value: unknown
    switch (call.stage) {
      case 'spec':
        value = this.scenario.spec
        break
      case 'architecture':
        value = this.scenario.architecture
        break
      case 'plan':
        value = this.scenario.plan
        break
      case 'scaffold':
        value = this.scenario.scaffold
        break
      case 'implement':
        value = this.scenario.review
        break
      case 'verify':
        if (this.scenario.repair === undefined) throw new Error('No repair scripted')
        value = this.scenario.repair
        break
      default:
        throw new Error(`Unexpected benchmark stage ${call.stage}`)
    }
    const usage = usageFor(call.system, call.prompt, JSON.stringify(value))
    this.calls.push({ stage: call.stage, input: usage.inputTokens, output: usage.outputTokens })
    return {
      value: value as T,
      model: `bench-${call.role}`,
      usage,
      durationMs: 1,
      attempts: 1
    }
  }

  async text(call: BuildTextCall): Promise<BuildModelResult<string>> {
    const usage = usageFor(call.system, call.prompt, this.scenario.readme)
    this.calls.push({ stage: call.stage, input: usage.inputTokens, output: usage.outputTokens })
    return {
      value: this.scenario.readme,
      model: 'bench-cheap',
      usage,
      durationMs: 1,
      attempts: 1
    }
  }
}

class ScriptedVerifier {
  private readonly queue: BuildVerification[]
  readonly calls: BuildVerification[] = []

  constructor(queue: BuildVerification[]) {
    this.queue = [...queue]
  }

  invalidate(): void {}

  async verify(options: BuildVerifyOptions): Promise<BuildVerification> {
    const template = this.queue.shift() ?? PASS
    const steps = template.steps.filter((step) => options.kinds.includes(step.kind))
    const passed = steps.every((step) => step.status === 'success')
    const result: BuildVerification = {
      steps,
      passed,
      summary: `Simulated verification — ${steps.filter((step) => step.status === 'failed').length} failed`
    }
    this.calls.push(result)
    return result
  }
}

function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel)
  return full === root || !full.startsWith(root + sep) ? null : full
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.gemibot' || entry.name === 'node_modules' || entry.name === '.git') continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(current, entry.name)
      if (entry.isDirectory()) await visit(full, rel)
      else if (entry.isFile()) found.push(rel)
    }
  }
  await visit(root, '')
  return found.sort()
}

async function normalModeEstimate(
  root: string,
  goal: string,
  planText: string,
  files: string[]
): Promise<ScenarioMetrics['normalModeEstimate']> {
  const system = buildAgentPrompt({ mode: 'build', responseStyle: 'balanced', complexity: 'complex' })
  let input = estimate(`${system}${goal}Plan the project and write every file.`)
  let output = estimate(planText)
  let context = planText
  for (const file of files) {
    const content = await readFile(join(root, file), 'utf8').catch(() => '')
    input += estimate(`${system}\n${goal}\n${context}\nWrite ${file} with its full content.`)
    const fileTokens = estimate(content)
    output += fileTokens
    context += content
  }
  input += estimate(`${system}\n${goal}\n${context}\nSummarize what you built.`)
  output += estimate('Done. All requested files were written and checked.')
  return { input, output, total: input + output, turns: files.length + 2 }
}

async function runScenario(scenario: BenchmarkScenario): Promise<ScenarioMetrics> {
  const root = await mkdtemp(join(tmpdir(), `gemibot-bench-${scenario.id}-`))
  const notes: string[] = []
  try {
    const models = new ScriptedModels(scenario)
    const verifier = new ScriptedVerifier(scenario.verifications)
    let runnerCalls = 0
    const runner = async (input: BuildTaskRunnerInput): Promise<BuildTaskRunnerResult> => {
      runnerCalls += 1
      const files = scenario.taskFiles[input.task.id] ?? []
      const tokenEstimate =
        estimate(input.prompt) +
        files.reduce((total, file) => total + estimate(file.content), 0)
      if (scenario.retryTask === input.task.id && runnerCalls === 1) {
        return {
          summary: '',
          filesChanged: [],
          error: 'Simulated task failure: missing export',
          model: input.model,
          durationMs: 1,
          tokens: tokenEstimate
        }
      }
      const changed: string[] = []
      for (const file of files) {
        const full = safeJoin(root, file.path)
        if (full === null) {
          return {
            summary: '',
            filesChanged: [],
            error: `Unsafe path rejected: ${file.path}`,
            model: input.model,
            durationMs: 1,
            tokens: tokenEstimate
          }
        }
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, file.content, 'utf8')
        changed.push(file.path)
      }
      return {
        summary: `Implemented ${input.task.title}`,
        filesChanged: changed,
        error: null,
        model: input.model,
        durationMs: 1,
        tokens: tokenEstimate
      }
    }

    const settings = normalizeBuildSettings({
      mode: 'auto',
      planApproval: 'auto',
      maxTokens: 500_000,
      maxSteps: 300,
      repairAttempts: 3,
      subAgents: 4,
      installDependencies: true,
      verifyEachMilestone: scenario.verifyEachMilestone === true,
      smokeTest: true,
      clarify: true
    })
    const orchestrator = new BuildOrchestrator({
      root,
      conversationId: null,
      goal: scenario.goal,
      settings,
      models: models as unknown as BuildModelService,
      runTask: runner,
      verifier: verifier as unknown as BuildVerifier,
      docs: new BuildDocsService(root),
      repoMap: new BuildRepoMapService(root),
      repository: { save: () => {} } as Pick<BuildRepository, 'save'>,
      onNotice: (text) => notes.push(text),
      onFinalReport: () => {}
    })

    const started = performance.now()
    await orchestrator.start()
    const durationMs = Math.round(performance.now() - started)
    const view = orchestrator.view
    const files = await listFiles(root)
    const verificationSteps = verifier.calls.flatMap((call) => call.steps)

    const input = view.usage.reduce((total, row) => total + row.inputTokens, 0)
    const output = view.usage.reduce((total, row) => total + row.outputTokens, 0)
    const total = view.usage.reduce((total, row) => total + row.totalTokens, 0)
    const taskTokens = Math.max(0, total - input - output)

    const planText = await readFile(join(root, '.gemibot', 'PLAN.md'), 'utf8').catch(() =>
      JSON.stringify(scenario.plan)
    )
    const normal = await normalModeEstimate(root, scenario.goal, planText, files)

    if (scenario.id === 'vague-request') {
      notes.push(
        `Recorded ${scenario.spec.assumptions.length} assumption(s) and ` +
          `${scenario.spec.clarifyQuestions.length} batched question(s).`
      )
    }
    if (scenario.retryTask !== undefined) {
      notes.push(`Task ${scenario.retryTask} failed once and was retried with the real error.`)
    }
    if (scenario.repair !== undefined && view.repairAttempts > 0) {
      notes.push('Final verification failed once and a real repair edit fixed it.')
    }

    return {
      id: scenario.id,
      name: scenario.name,
      status: view.status,
      success: view.status === 'success',
      durationMs,
      filesCreated: files.length,
      tasks: view.tasksTotal,
      tasksSucceeded: view.tasksDone,
      verifications: verifier.calls.length,
      commands: verificationSteps.length,
      builds: verificationSteps.filter((step) => step.kind === 'build').length,
      tests: verificationSteps.filter((step) => step.kind === 'test').length,
      smoke: verificationSteps.filter((step) => step.kind === 'smoke').length,
      taskRetries: Math.max(0, runnerCalls - view.tasksTotal),
      repairs: view.repairAttempts,
      steps: view.stepsUsed,
      tokens: { input, output, task: taskTokens, total: view.tokensUsed },
      normalModeEstimate: normal,
      notes
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function runBenchmark(): Promise<BenchmarkReport> {
  const scenarios: ScenarioMetrics[] = []
  for (const scenario of SCENARIOS) {
    scenarios.push(await runScenario(scenario))
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: 'fake',
    caveat:
      'Fake-mode measurements use a scripted model and a simulated verifier; no API key or network was used. ' +
      'Normal mode is a chars/4 estimate of one tool turn per file with full history, so it is a lower bound, not an API measurement.',
    scenarios,
    totals: {
      scenarios: scenarios.length,
      succeeded: scenarios.filter((scenario) => scenario.success).length,
      durationMs: scenarios.reduce((total, scenario) => total + scenario.durationMs, 0),
      tokens: scenarios.reduce((total, scenario) => total + scenario.tokens.total, 0),
      normalModeEstimate: scenarios.reduce(
        (total, scenario) => total + scenario.normalModeEstimate.total,
        0
      ),
      repairs: scenarios.reduce((total, scenario) => total + scenario.repairs, 0),
      taskRetries: scenarios.reduce((total, scenario) => total + scenario.taskRetries, 0),
      filesCreated: scenarios.reduce((total, scenario) => total + scenario.filesCreated, 0)
    }
  }
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width)
}

export function printReport(report: BenchmarkReport): void {
  const lines: string[] = []
  lines.push('Build mode benchmark — scripted fake model, simulated verification')
  lines.push(
    `${pad('Scenario', 24)}${pad('Result', 9)}${pad('Files', 7)}${pad('Tasks', 7)}${pad('Verify', 8)}` +
      `${pad('Cmds', 6)}${pad('Builds', 8)}${pad('Tests', 7)}${pad('Smoke', 7)}` +
      `${pad('Retry', 7)}${pad('Repair', 8)}${pad('Tokens', 10)}${pad('Normal*', 10)}${pad('Time', 8)}`
  )
  for (const scenario of report.scenarios) {
    lines.push(
      `${pad(scenario.name, 24)}${pad(scenario.status, 9)}${pad(scenario.filesCreated, 7)}` +
        `${pad(scenario.tasks, 7)}${pad(scenario.verifications, 8)}${pad(scenario.commands, 6)}` +
        `${pad(scenario.builds, 8)}${pad(scenario.tests, 7)}${pad(scenario.smoke, 7)}` +
        `${pad(scenario.taskRetries, 7)}${pad(scenario.repairs, 8)}${pad(scenario.tokens.total, 10)}` +
        `${pad(scenario.normalModeEstimate.total, 10)}${pad(`${scenario.durationMs}ms`, 8)}`
    )
  }
  const totals = report.totals
  lines.push('')
  lines.push(
    `Totals: ${totals.succeeded}/${totals.scenarios} succeeded · ${totals.filesCreated} files · ` +
      `${totals.tokens} build tokens · ${totals.normalModeEstimate} normal-mode estimate · ` +
      `${totals.repairs} repair(s) · ${totals.taskRetries} task retry(ies) · ${totals.durationMs}ms`
  )
  lines.push(`* ${report.caveat}`)
  for (const scenario of report.scenarios) {
    for (const note of scenario.notes) lines.push(`  ${scenario.id}: ${note}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

interface CliOptions {
  json?: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = argv[index + 1]
      index += 1
    }
  }
  return options
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<BenchmarkReport> {
  const options = parseArgs(argv)
  const report = await runBenchmark()
  printReport(report)
  if (options.json !== undefined && options.json.trim() !== '') {
    const cwd = resolve(process.cwd())
    const target = resolve(cwd, options.json)
    if (target !== cwd && !target.startsWith(cwd + sep)) {
      throw new Error('Benchmark JSON output must stay inside the project folder.')
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`Wrote ${target}\n`)
  }
  return report
}
