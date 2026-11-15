export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, status: number, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; retryable?: boolean } } | null)?.error;
    throw new ApiError(err?.code ?? "HTTP_" + res.status, res.status, err?.message ?? "Something went wrong. Please try again.", err?.retryable ?? res.status >= 500);
  }
  return json as T;
}

const HEADERS = { "x-vocamail": "1" };

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: init.body !== undefined ? { ...HEADERS, "Content-Type": "application/json" } : HEADERS,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError("NETWORK", 0, "Can't reach the app server. Check your connection.", true);
  }
  return handle<T>(res);
}

/** Multipart upload with progress (fetch can't report upload progress). */
export function uploadForm<T>(path: string, form: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("x-vocamail", "1");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError("NETWORK", 0, "The upload failed. Check your connection and try again.", true));
    xhr.onload = () => {
      handle<T>(new Response(xhr.responseText, { status: xhr.status })).then(resolve, reject);
    };
    xhr.send(form);
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}
