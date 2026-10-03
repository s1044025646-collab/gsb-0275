export type ErrorCode =
  | "INVALID_PARAM"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "LIMIT_EXCEEDED"
  | "INTERNAL";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 400,
  ) {
    super(message);
  }
}
