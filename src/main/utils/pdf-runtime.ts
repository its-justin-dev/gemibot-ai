const wellKnownSymbols = Symbol as unknown as Record<string, unknown>

if (wellKnownSymbols.dispose === undefined) wellKnownSymbols.dispose = Symbol('Node.dispose')

export {}
