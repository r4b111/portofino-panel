export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
