export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
