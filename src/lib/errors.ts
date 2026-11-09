export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
