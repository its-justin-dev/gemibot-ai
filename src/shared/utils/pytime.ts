export function pyTime(): number {
  return (performance.timeOrigin + performance.now()) / 1000
}
