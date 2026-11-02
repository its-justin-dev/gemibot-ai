import { pyStrip } from '../utils/pystr'

export class EffortLevel {
  static readonly DECLARED: EffortLevel[] = []

  static readonly LOW = new EffortLevel('LOW', 'low')
  static readonly MEDIUM = new EffortLevel('MEDIUM', 'medium')
  static readonly HIGH = new EffortLevel('HIGH', 'high')
  static readonly EXTRA_HIGH = new EffortLevel('EXTRA_HIGH', 'extra_high')
  static readonly TURBO = new EffortLevel('TURBO', 'turbo')
  // Declared last on purpose: `fromString` matches the empty string against the first declared
  // level, and v1.0 recorded that as Low.
  static readonly SAVING = new EffortLevel('SAVING', 'saving')

  private constructor(
    readonly name: string,
    readonly value: string
  ) {
    EffortLevel.DECLARED.push(this)
  }

  get displayName(): string {
    const names: Record<string, string> = {
      LOW: 'Low',
      MEDIUM: 'Medium',
      HIGH: 'High',
      EXTRA_HIGH: 'Extra High',
      TURBO: 'Turbo',
      SAVING: 'Saving'
    }
    return names[this.name] ?? 'Medium'
  }

  get icon(): string {
    const icons: Record<string, string> = {
      LOW: '⚡',
      MEDIUM: '⚖️',
      HIGH: '🧠',
      EXTRA_HIGH: '🚀',
      TURBO: '🏎️',
      SAVING: '🪶'
    }
    return icons[this.name] ?? '🧠'
  }

  get description(): string {
    const descriptions: Record<string, string> = {
      LOW: 'Fastest response with minimal reasoning (512 tokens).',
      MEDIUM: 'Balanced reasoning for general coding (2k tokens).',
      HIGH: 'Deep reasoning for complex logic (8k tokens).',
      EXTRA_HIGH: 'Maximum reasoning for complex tasks (16k tokens).',
      TURBO: 'No thinking tokens - absolute fastest response.',
      SAVING: 'Cheapest on tokens: 128 thinking plus a trimmed prompt.'
    }
    return descriptions[this.name] ?? ''
  }

  get costHint(): string {
    const hints: Record<string, string> = {
      LOW: 'Fastest (~512 tokens)',
      MEDIUM: 'Balanced (~2k tokens)',
      HIGH: 'Deep (~8k tokens)',
      EXTRA_HIGH: 'Maximum (~16k tokens)',
      TURBO: 'No thinking (fastest)',
      SAVING: 'Lowest (~128 tokens)'
    }
    return hints[this.name] ?? ''
  }

  toString(): string {
    return this.value
  }

  equals(other: EffortLevel | string | null | undefined): boolean {
    if (other == null) return false
    return typeof other === 'string' ? this.value === other : this.value === other.value
  }

  static fromString(val: unknown): EffortLevel {
    if (val === null || val === undefined) return EffortLevel.MEDIUM
    if (val instanceof EffortLevel) return val
    let clean = pyStrip(String(val)).toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
    if (clean.includes('.')) clean = clean.split('.').at(-1) ?? clean
    for (const level of EffortLevel.DECLARED) {
      if (level.value === clean || level.name.toLowerCase() === clean) return level
      if (level.displayName.toLowerCase().includes(clean)) return level
    }
    return EffortLevel.MEDIUM
  }

  static allLevels(): EffortLevel[] {
    // v1.0's five levels keep their exact positions, so `/effort 3` still means Medium; the
    // level we added trails the list in both the CLI menu and the GUI picker.
    return [
      EffortLevel.TURBO,
      EffortLevel.LOW,
      EffortLevel.MEDIUM,
      EffortLevel.HIGH,
      EffortLevel.EXTRA_HIGH,
      EffortLevel.SAVING
    ]
  }
}
