import { createSmartBeeDocument, type SmartBeeEnv } from "./smartbee-client";
import { buildReceiptInput } from "./mcp";

export interface ReceiptEnv extends SmartBeeEnv {
  SMARTBEE_RECEIPT_KEY?: string;
  /** Set to "1" to make every receipt a draft: nothing official is issued, nothing is emailed. */
  SMARTBEE_FORCE_DRAFT?: string;
}

const json = (body: unknown, status: number) => Response.json(body, { status });

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Returns an error Response when the x-api-key header is missing or wrong, otherwise null. Fails closed. */
export async function requireKey(request: Request, env: ReceiptEnv): Promise<Response | null> {
  if (!env.SMARTBEE_RECEIPT_KEY) return json({ error: "Server not configured (SMARTBEE_RECEIPT_KEY missing)" }, 503);
  const given = request.headers.get("x-api-key") ?? "";
  const [a, b] = await Promise.all([digest(given), digest(env.SMARTBEE_RECEIPT_KEY)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 ? null : json({ error: "Unauthorized" }, 401);
}

/** The same order_id always maps to the same SmartBee idempotency key, so a retry cannot issue a second receipt. */
async function msgIdFor(orderId: string): Promise<string> {
  const hex = Array.from(await digest(`receipt:${orderId}`)).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** POST /receipt: one simple request from a site (Base44, Lovable ...) after a confirmed payment. */
export async function handleReceipt(request: Request, env: ReceiptEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  const denied = await requireKey(request, env);
  if (denied) return denied;

  let body: Record<string, any>;
  try {
    body = (await request.json()) as Record<string, any>;
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const orderId = typeof body.order_id === "string" || typeof body.order_id === "number" ? String(body.order_id).trim() : "";
  if (!orderId || orderId.length > 100) return json({ error: "order_id is required (1-100 chars)" }, 400);
  if (typeof body.customer_name !== "string" || body.customer_name.trim().length < 2) {
    return json({ error: "customer_name is required (2-100 chars)" }, 400);
  }

  try {
    const input = buildReceiptInput(body);
    input.providerMsgId = await msgIdFor(orderId);
    input.providerMsgReferenceId = `order-${orderId}`.slice(0, 60);
    const draft = env.SMARTBEE_FORCE_DRAFT === "1" || body.draft === true;
    if (draft) {
      input.isDraft = true;
      input.creationMetadata = { ...(input.creationMetadata ?? {}), sendOriginalToCustomer: false };
    }
    const out = await createSmartBeeDocument(env, input);
    switch (out.status) {
      case "created":
        return json(
          {
            status: "created",
            receipt_number: out.document.index,
            pdf_link: out.document.linkToOriginal,
            copy_link: out.document.linkToCopy,
            document_id: out.document.documentId,
          },
          201,
        );
      case "draft":
        return json({ status: "draft", draft_document_id: out.document.draftDocumentId, note: "Saved as a draft in SmartBee, nothing was issued or emailed" }, 201);
      case "duplicate":
        return json({ status: "duplicate", message: "A receipt for this order_id was already requested" }, 200);
      case "pending":
        return json({ status: "pending", msg_id: out.msgId }, 202);
      case "error":
        return json({ status: "error", result_code: out.resultCodeId, validation_errors: out.validationErrors }, 422);
    }
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }
}
