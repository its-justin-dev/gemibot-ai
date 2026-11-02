const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const ABBREV_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const ABBREV_MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, '0')
}

function utcOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

export function strftime(date: Date, fmt: string): string {
  let out = ''
  let i = 0
  while (i < fmt.length) {
    const ch = fmt[i]
    if (ch !== '%' || i + 1 >= fmt.length) {
      out += ch
      i += 1
      continue
    }
    const d = fmt[i + 1]
    i += 2
    const hour = date.getHours()
    const hour12 = hour % 12 === 0 ? 12 : hour % 12
    switch (d) {
      case '%':
        out += '%'
        break
      case 'Y':
        out += pad(date.getFullYear(), 4)
        break
      case 'y':
        out += pad(date.getFullYear() % 100)
        break
      case 'm':
        out += pad(date.getMonth() + 1)
        break
      case 'B':
        out += MONTH_NAMES[date.getMonth()]
        break
      case 'b':
      case 'h':
        out += ABBREV_MONTH_NAMES[date.getMonth()]
        break
      case 'd':
        out += pad(date.getDate())
        break
      case 'A':
        out += DAY_NAMES[(date.getDay() + 6) % 7]
        break
      case 'a':
        out += ABBREV_DAY_NAMES[(date.getDay() + 6) % 7]
        break
      case 'H':
        out += pad(hour)
        break
      case 'I':
        out += pad(hour12)
        break
      case 'M':
        out += pad(date.getMinutes())
        break
      case 'S':
        out += pad(date.getSeconds())
        break
      case 'p':
        out += hour < 12 ? 'AM' : 'PM'
        break
      case 'j': {
        const start = new Date(date.getFullYear(), 0, 1)
        out += pad(Math.floor((date.getTime() - start.getTime()) / 86400000) + 1, 3)
        break
      }
      case 'f':
        out += pad(date.getMilliseconds(), 3).padEnd(6, '0')
        break
      case 'z':
        out += utcOffset(date)
        break
      case 'Z':
        out += Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
        break
      case 'c':
        out += strftime(date, '%a %b %d %H:%M:%S %Y')
        break
      case 'x':
        out += strftime(date, '%m/%d/%y')
        break
      case 'X':
        out += strftime(date, '%H:%M:%S')
        break
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      default:
        out += `%${d}`
    }
  }
  return out
}

export function nowStrftime(fmt: string, date = new Date()): string {
  return strftime(date, fmt)
}
