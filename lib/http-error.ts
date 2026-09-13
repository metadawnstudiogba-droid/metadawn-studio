// Only intentionally public messages may be included in API errors.
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
