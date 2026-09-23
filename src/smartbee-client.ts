// SmartBee client - correct flow per SMARTBEE-API-INTEGRATION.md:
// 1) POST /login/authenticate -> JWT (Bearer, 7 days)
// 2) POST /documents/create (providerUserToken in BODY) -> message ID
// 3) Poll GET /documents/{msgId} until 102/103 or terminal code
// Users/loginToken is NOT part of this flow (confirmed by SmartBee support 2026-09-23).
import {
  ResultCode,
  POLL_CONTINUE_CODES,
  SMARTBEE_BASE_URL,
  type CreateDocumentResponse,
  type DocumentCreatedResult,
  type DocumentRequest,
  type DraftCreatedResult,
  type LoginResponse,
  type PollDocumentResponse,
} from "./types/smartbee";

export interface SmartBeeEnv {
  SMARTBEE_CLIENT_ID: string;
  SMARTBEE_PASSWORD: string;
  PROVIDERUSERTOKEN: string;
  SMARTBEE_ENV?: "test" | "prod"; // defaults to test
}

/** What callers send. Provider IDs are optional; they are generated if missing. */
export type DocumentInput = Omit
  DocumentRequest,
  "providerUserToken" | "providerMsgId" | "providerMsgReferenceId"
> &
  Partial<Pick<DocumentRequest, "providerMsgId" | "providerMsgReferenceId">>;

export type DocumentOutcome =
  | { status: "created"; msgId: string; document: DocumentCreatedResult }
  | { status: "draft"; msgId: string; document: DraftCreatedResult }
  | { status: "pending"; msgId: string }
  | { status: "duplicate"; msgId?: string }
  | { status: "error"; msgId?: string; resultCodeId: number; validationErrors: Record<string, string> | null };

const baseUrl = (env: SmartBeeEnv) => SMARTBEE_BASE_URL[env.SMARTBEE_ENV === "prod" ? "prod" : "test"];

// ---------- Auth (per-isolate cache; move to client KV later) ----------
let cached: { token: string; expiresAt: number } | null = null;
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // re-auth 1h before expiry

async function authenticate(env: SmartBeeEnv): Promise<string> {
  const res = await fetch(`${baseUrl(env)}/login/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: env.SMARTBEE_CLIENT_ID, password: env.SMARTBEE_PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SmartBee auth failed: ${res.status} ${text}`);
  const data = JSON.parse(text) as LoginResponse;
  if (!data?.token) throw new Error(`SmartBee auth response missing token: ${text}`);
  cached = { token: data.token, expiresAt: Date.parse(data.expirationUtcDate) || Date.now() + 6 * 864e5 };
  return data.token;
}

async function getToken(env: SmartBeeEnv): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.token;
  return authenticate(env);
}

/** Authorized fetch: on HTTP 401 re-authenticate once and retry. */
async function sbFetch(env: SmartBeeEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = (token: string) =>
    fetch(`${baseUrl(env)}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  let res = await doFetch(await getToken(env));
  if (res.status === 401) {
    cached = null;
    res = await doFetch(await authenticate(env));
  }
  return res;
}

async function readJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`SmartBee ${label} failed: ${res.status} ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`SmartBee ${label} returned non-JSON body: ${text}`);
  }
}

// ---------- Documents ----------
export async function getDocumentStatus(env: SmartBeeEnv, msgId: string): Promise<DocumentOutcome> {
  const data = await readJson<PollDocumentResponse>(
    await sbFetch(env, `/documents/${encodeURIComponent(msgId)}`, { method: "GET" }),
    "poll",
  );
  switch (data.resultCodeId) {
    case ResultCode.DocCreated:
      return { status: "created", msgId, document: data.result as DocumentCreatedResult };
    case ResultCode.DraftCreated:
      return { status: "draft", msgId, document: data.result as DraftCreatedResult };
    default:
      if (POLL_CONTINUE_CODES.includes(data.resultCodeId)) return { status: "pending", msgId };
      return { status: "error", msgId, resultCodeId: data.resultCodeId, validationErrors: data.validationErrors };
  }
}

/**
 * Queue a document and poll with backoff (1s, 2s, 4s, 8s...) up to maxWaitMs.
 * If still processing, returns { status: "pending", msgId } - call getDocumentStatus later.
 */
export async function createSmartBeeDocument(
  env: SmartBeeEnv,
  input: DocumentInput,
  maxWaitMs = 20_000,
): Promise<DocumentOutcome> {
  const request: DocumentRequest = {
    ...input,
    providerUserToken: env.PROVIDERUSERTOKEN,
    providerMsgId: input.providerMsgId ?? crypto.randomUUID(),
    providerMsgReferenceId: input.providerMsgReferenceId ?? crypto.randomUUID(),
    // PoC safety: never email the customer unless explicitly requested.
    creationMetadata: { sendOriginalToCustomer: false, ...(input.creationMetadata ?? {}) },
  };

  const created = await readJson<CreateDocumentResponse>(
    await sbFetch(env, "/documents/create", { method: "POST", body: JSON.stringify(request) }),
    "document create",
  );

  if (created.resultCodeId === ResultCode.DuplicatedMessage) return { status: "duplicate" };
  if (created.resultCodeId !== ResultCode.DocCreationRequestCreated || !created.result) {
    return { status: "error", resultCodeId: created.resultCodeId, validationErrors: created.validationErrors };
  }

  const msgId = created.result;
  const deadline = Date.now() + maxWaitMs;
  let wait = 1000;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "pending", msgId };
    await new Promise((r) => setTimeout(r, Math.min(wait, remaining)));
    const outcome = await getDocumentStatus(env, msgId);
    if (outcome.status !== "pending") return outcome;
    wait = Math.min(wait * 2, 30_000);
  }
}
