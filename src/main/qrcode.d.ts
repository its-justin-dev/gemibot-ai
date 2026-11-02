declare module 'qrcode' {
  export interface QrSegment {
    data: string
    mode: string
  }

  export interface QrOptions {
    version?: number
    errorCorrectionLevel?: string
    maskPattern?: number
  }

  export interface QrSymbol {
    modules: {
      size: number
      get(row: number, col: number): number
    }
    version: number
    maskPattern: number
  }

  export function create(data: string | QrSegment[], options?: QrOptions): QrSymbol

  const qrcode: { create: typeof create }
  export default qrcode
}
