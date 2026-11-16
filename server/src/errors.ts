export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (msg: string) => new AppError(400, msg)
export const notFound = (msg: string) => new AppError(404, msg)

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    return cause instanceof Error && cause.message ? `${e.message}: ${cause.message}` : e.message
  }
  return String(e)
}
