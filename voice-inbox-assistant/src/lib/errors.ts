import { NextResponse } from "next/server";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Turns any thrown error into a JSON response the UI can show as-is. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("[api] unexpected error:", err);
  return NextResponse.json({ error: "Something went wrong on the server. Please try again.", code: "INTERNAL" }, { status: 500 });
}
