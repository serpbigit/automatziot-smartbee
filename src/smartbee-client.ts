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
  type DocumentSearchItem,
  type DocumentsSearchRequest,
  type DocumentsSearchResponse,
  type DocumentType,
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
export type DocumentInput = Omit<
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

// ---------- Search ----------
export interface SearchInput {
  customerName?: string;   // matched client-side (API has no name filter)
  docType?: DocumentType;
  documentNumber?: number;
  fromDate?: string;
  toDate?: string;
  limit?: number;          // max results returned (default 5)
}

export interface DocumentSummary {
  id: string;
  number: number;
  type: DocumentType;
  date: string;
  customerName?: string;
  customerEmail?: string;
  total?: unknown;
  linkToOriginal: string;
}

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function summarize(d: DocumentSearchItem): DocumentSummary {
  const c = (d.customer ?? {}) as Record<string, unknown>;
  const inv = (d.invoiceDetails ?? {}) as Record<string, unknown>;
  return {
    id: d.id,
    number: d.index,
    type: d.docType,
    date: d.creationDate,
    customerName: c.name as string | undefined,
    customerEmail: c.email as string | undefined,
    total: inv.total,
    linkToOriginal: d.linkToOriginal,
  };
}

/** Newest-first search. Name filter scans up to 4 pages of 50 documents. */
export async function searchDocuments(env: SmartBeeEnv, input: SearchInput): Promise<DocumentSummary[]> {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 25);
  const wanted = norm(input.customerName);
  const pageSize = wanted ? 50 : limit;
  const maxPages = wanted ? 4 : 1;
  const out: DocumentSummary[] = [];

  for (let page = 0; page < maxPages && out.length < limit; page++) {
    const req: DocumentsSearchRequest = {
      providerUserToken: env.PROVIDERUSERTOKEN,
      page,
      amountPerPage: pageSize,
      sortingField: "docDate",
      sortDirection: "Descending",
      producibleDocumentType: input.docType,
      documentIndex: input.documentNumber,
      fromDate: input.fromDate,
      toDate: input.toDate,
    };
    const data = await readJson<DocumentsSearchResponse>(
      await sbFetch(env, "/documents/search", { method: "POST", body: JSON.stringify(req) }),
      "document search",
    );
    if (data.resultCodeId !== ResultCode.DocSearchSuccessful || !data.result) {
      throw new Error(`SmartBee search failed (resultCodeId=${data.resultCodeId}): ${JSON.stringify(data.validationErrors)}`);
    }
    const items = data.result.items ?? [];
    for (const d of items) {
      if (wanted && !norm((d.customer as Record<string, unknown> | undefined)?.name).includes(wanted)) continue;
      out.push(summarize(d));
      if (out.length >= limit) break;
    }
    if (items.length < pageSize) break; // no more pages
  }
  return out;
}

// ---------- Update (handled flag) ----------
/** Resolve a document by its visible number (optionally type) to SmartBee's internal id. */
export async function findDocumentId(env: SmartBeeEnv, documentNumber: number, docType?: DocumentType): Promise<string> {
  const req: DocumentsSearchRequest = {
    providerUserToken: env.PROVIDERUSERTOKEN,
    page: 0,
    amountPerPage: 10,
    documentIndex: documentNumber,
    producibleDocumentType: docType,
  };
  const data = await readJson<DocumentsSearchResponse>(
    await sbFetch(env, "/documents/search", { method: "POST", body: JSON.stringify(req) }),
    "document search",
  );
  const items = (data.result?.items ?? []).filter((d) => d.index === documentNumber && (!docType || d.docType === docType));
  if (items.length === 0) throw new Error(`No document number ${documentNumber}${docType ? ` of type ${docType}` : ""} found`);
  if (items.length > 1) throw new Error(`Several documents have number ${documentNumber}; specify the document type`);
  return items[0].id;
}

export async function setDocumentHandled(env: SmartBeeEnv, documentId: string, isHandled: boolean) {
  const data = await readJson<{ resultCodeId: number; result: unknown; validationErrors: Record<string, string> | null }>(
    await sbFetch(env, "/documents/update", {
      method: "POST",
      body: JSON.stringify({ providerUserToken: env.PROVIDERUSERTOKEN, documentId, isHandled }),
    }),
    "document update",
  );
  if (data.resultCodeId !== ResultCode.DocUpdateSuccessful) {
    throw new Error(`SmartBee update failed (resultCodeId=${data.resultCodeId}): ${JSON.stringify(data.validationErrors)}`);
  }
  return { documentId, isHandled, status: "OK" };
}

// ---------- Summary over a date range ----------
export async function summarizeDocuments(
  env: SmartBeeEnv,
  input: { fromDate: string; toDate?: string; docType?: DocumentType },
) {
  const pageSize = 50;
  const byType: Record<string, { count: number; total: number }> = {};
  const byCustomer: Record<string, { count: number; total: number }> = {};
  let count = 0;
  let scanned = 0;
  let truncated = false;

  for (let page = 0; page < 10; page++) {
    const req: DocumentsSearchRequest = {
      providerUserToken: env.PROVIDERUSERTOKEN,
      page,
      amountPerPage: pageSize,
      sortingField: "docDate",
      sortDirection: "Descending",
      fromDate: input.fromDate,
      toDate: input.toDate,
      producibleDocumentType: input.docType,
    };
    const data = await readJson<DocumentsSearchResponse>(
      await sbFetch(env, "/documents/search", { method: "POST", body: JSON.stringify(req) }),
      "document search",
    );
    if (data.resultCodeId !== ResultCode.DocSearchSuccessful || !data.result) {
      throw new Error(`SmartBee search failed (resultCodeId=${data.resultCodeId})`);
    }
    const items = data.result.items ?? [];
    for (const d of items) {
      const inv = (d.invoiceDetails ?? {}) as Record<string, unknown>;
      const rec = (d.receiptDetails ?? {}) as Record<string, unknown>;
      const total = Number(inv.total ?? rec.totalPaid ?? 0) || 0;
      const cust = String((d.customer as Record<string, unknown> | undefined)?.name ?? "(no name)");
      (byType[d.docType] ??= { count: 0, total: 0 }).count++;
      byType[d.docType].total += total;
      (byCustomer[cust] ??= { count: 0, total: 0 }).count++;
      byCustomer[cust].total += total;
      count++;
    }
    scanned += items.length;
    if (items.length < pageSize) break;
    if (page === 9) truncated = true;
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  for (const v of Object.values(byType)) v.total = round(v.total);
  for (const v of Object.values(byCustomer)) v.total = round(v.total);
  return { fromDate: input.fromDate, toDate: input.toDate ?? "now", documentCount: count, byType, byCustomer, truncated };
}

// ---------- Expenses ----------
interface ExpenseItem {
  id: string;
  expenseDate?: string;
  description?: string;
  sum?: number;
  expenseType?: { name?: string; group?: string };
  supplier?: { name?: string };
  isDeleted?: boolean;
}

export async function searchExpenses(env: SmartBeeEnv, input: { fromDate?: string; toDate?: string }) {
  const pageSize = 50;
  const byType: Record<string, number> = {};
  const recent: { date?: string; supplier?: string; type?: string; description?: string; sum?: number }[] = [];
  let count = 0;
  let total = 0;

  for (let page = 0; page < 6; page++) {
    const data = await readJson<{ resultCodeId: number; result: { items?: ExpenseItem[] } | null; validationErrors: unknown }>(
      await sbFetch(env, "/expenses/search", {
        method: "POST",
        body: JSON.stringify({
          providerUserToken: env.PROVIDERUSERTOKEN,
          page,
          amountPerPage: pageSize,
          sortingField: "expenseDate",
          sortDirection: "Descending",
          fromExpenseDate: input.fromDate,
          toExpenseDate: input.toDate,
        }),
      }),
      "expense search",
    );
    if (data.resultCodeId !== ResultCode.ExpensesSearchSuccessful || !data.result) {
      throw new Error(`SmartBee expense search failed (resultCodeId=${data.resultCodeId}): ${JSON.stringify(data.validationErrors)}`);
    }
    const items = (data.result.items ?? []).filter((e) => !e.isDeleted);
    for (const e of items) {
      const sum = Number(e.sum ?? 0) || 0;
      const type = e.expenseType?.name ?? "(uncategorized)";
      byType[type] = Math.round(((byType[type] ?? 0) + sum) * 100) / 100;
      total += sum;
      count++;
      if (recent.length < 10) {
        recent.push({ date: e.expenseDate, supplier: e.supplier?.name, type, description: e.description, sum });
      }
    }
    if ((data.result.items ?? []).length < pageSize) break;
  }
  return { fromDate: input.fromDate ?? "(all)", toDate: input.toDate ?? "now", count, total: Math.round(total * 100) / 100, byType, recent };
}
