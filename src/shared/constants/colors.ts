export const Colors = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  ITALIC: '\x1b[3m',
  CYAN: '\x1b[96m',
  GREEN: '\x1b[92m',
  YELLOW: '\x1b[93m',
  RED: '\x1b[91m',
  MAGENTA: '\x1b[95m',
  BLUE: '\x1b[94m',
  WHITE: '\x1b[97m',
  GRAY: '\x1b[90m',
  BG_BUILD: '\x1b[48;5;29m\x1b[97m',
  BG_PLAN: '\x1b[48;5;136m\x1b[97m',
  BG_READ: '\x1b[48;5;24m\x1b[97m',
  BG_FUNC: '\x1b[48;5;93m\x1b[97m',
  BG_BADGE: '\x1b[48;5;236m\x1b[97m'
} as const

export const C = Colors
