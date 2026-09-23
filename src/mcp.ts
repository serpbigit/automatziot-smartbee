// Minimal stateless MCP server (Streamable HTTP, JSON responses) for Claude custom connectors.
// Route: POST /mcp/<MCP_TOKEN>. Disabled entirely if MCP_TOKEN is not set.
import {
  createSmartBeeDocument,
  findDocumentId,
  getDocumentStatus,
  searchDocuments,
  searchExpenses,
  setDocumentHandled,
  summarizeDocuments,
  type SmartBeeEnv,
} from "./smartbee-client";
import type { Customer, DocumentType, PaymentItem, ReceiptDetailsRequest } from "./types/smartbee";

const SERVER_INFO = { name: "automatziot-smartbee", version: "0.5.1" };
const DEFAULT_PROTOCOL = "2025-06-18";

const INSTRUCTIONS =
  "SmartBee accounting connector (Automatziot). Creates quotes and receipts, finds documents, closes quotes, " +
  "and summarizes income and expenses in the user's SmartBee account. When the user asks what you can do with SmartBee, " +
  "call list_capabilities. Always confirm details before create_quote, create_receipt or mark_handled. " +
  "A business card photo can be used as the source of customer details. " +
  "Always reply in the same language the user writes or speaks in (e.g. Hebrew or English), even though tool results are in English.";

const CAPABILITIES = {
  title: "מה אפשר לעשות עם SmartBee דרך Claude",
  capabilities: [
    { name: "הצעת מחיר ללקוח (חדש או קיים)", example: "צלם כרטיס ביקור: 'שלח לו הצעת מחיר לשעת ייעוץ ב-300'", needsApproval: true,
      note: "לקוח חדש נוצר אוטומטית ב-SmartBee" },
    { name: "קבלה על תשלום", example: "'נחמה שילמה 300 בביט, תוציא לה קבלה ותשלח לה'", needsApproval: true,
      note: "מזומן, ביט, פייבוקס, אשראי, העברה בנקאית, צ'ק" },
    { name: "חיפוש מסמכים", example: "'מה הצעת המחיר האחרונה?' / 'מה שלחתי לנחמה?' / 'הצעה מספר 5'", needsApproval: false },
    { name: "סגירת הצעה כטופלה", example: "'נחמה אישרה, תסגור את ההצעה שלה'", needsApproval: true },
    { name: "סיכום חודשי", example: "'כמה הצעות מחיר הוצאתי החודש ולמי?'", needsApproval: false },
    { name: "סיכום הוצאות", example: "'כמה הוצאתי החודש? כמה על דלק?'", needsApproval: false },
  ],
  safety: "כל פעולה שיוצרת מסמך או משנה אותו דורשת אישור שלך לפני ביצוע. מסמכים רשמיים (קבלות) אינם ניתנים למחיקה.",
  privacy: "החיבור רץ בחשבון Cloudflare של העסק. לספק החיבור (Automatziot) אין גישה למסמכים או לפרטי הלקוחות.",
};

const TOOLS = [
  {
    name: "list_capabilities",
    description:
      "List everything this SmartBee connector can do, with example phrases (Hebrew). Call this when the user asks " +
      "what you can help with in SmartBee / accounting / quotes. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_quote",
    description:
      "Create a price quote (hatzaat mechir) in SmartBee for a customer. If the customer does not exist yet, " +
      "SmartBee creates them automatically from these details. Returns the quote number and PDF links. " +
      "Before calling, confirm the customer details and line items with the user.",
    inputSchema: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Customer full name (2-100 chars)" },
        customer_email: { type: "string", description: "Customer email. Also used as the stable customer ID." },
        customer_phone: { type: "string", description: "Customer phone number" },
        customer_address: { type: "string", description: "Street address (4-30 chars)" },
        customer_city: { type: "string", description: "City (2-30 chars)" },
        items: {
          type: "array",
          description: "Quote line items",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              price: { type: "number", description: "Price per unit in ILS" },
              vat_included: { type: "boolean", description: "True if price already includes VAT (default true)" },
            },
            required: ["description", "quantity", "price"],
          },
        },
        comments: { type: "string", description: "Optional comments shown on the quote" },
        send_to_customer: {
          type: "boolean",
          description: "Email the quote PDF to the customer. Default false. Only true if the user explicitly asks to send it.",
        },
      },
      required: ["customer_name", "items"],
    },
  },
  {
    name: "search_documents",
    description:
      "Find existing SmartBee documents (quotes, invoices, receipts) newest first. Use this for questions like " +
      "'the latest quote', 'quotes for Nechama', 'quote number 12', 'documents from this week'. Read-only. " +
      "Returns document number, type, date, customer name/email, total and PDF link. " +
      "Name matching is literal: if no match, retry with the other spelling (Hebrew vs English transliteration).",
    inputSchema: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Full or partial customer name (Hebrew or English)" },
        doc_type: {
          type: "string",
          enum: ["PriceProposal", "Invoice", "InvoiceReceipt", "Receipt", "DealInvoice", "RefundInvoice", "ReceiptRefund", "OrderConfirmation", "ShippingCertificate", "DonationReceipt", "ReturnCertificate"],
          description: "Document type. PriceProposal = quote (hatzaat mechir).",
        },
        document_number: { type: "number", description: "The sequential document number shown on the PDF" },
        from_date: { type: "string", description: "ISO date, e.g. 2026-09-01" },
        to_date: { type: "string", description: "ISO date" },
        limit: { type: "number", description: "Max results (default 5, max 25)" },
      },
    },
  },
  {
    name: "create_receipt",
    description:
      "Issue a receipt (kabala) in SmartBee for a payment already received. This is an official tax document with a running " +
      "number and cannot be deleted, so ALWAYS show the customer, amount, payment method and date to the user and get explicit " +
      "confirmation first. Creates the customer automatically if new.",
    inputSchema: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Customer full name (2-100 chars)" },
        customer_email: { type: "string", description: "Customer email. Also used as the stable customer ID." },
        customer_phone: { type: "string" },
        amount: { type: "number", description: "Amount received in ILS" },
        payment_method: {
          type: "string",
          enum: ["cash", "bit", "paybox", "credit_card", "bank_transfer", "check", "other"],
        },
        payment_date: { type: "string", description: "ISO date of payment. Default: now" },
        description: { type: "string", description: "What the payment is for, e.g. 'Payment for quote #5'. Shown on the receipt." },
        card_last_digits: { type: "string", description: "credit_card only: last 4 digits" },
        bank_name: { type: "string", description: "bank_transfer / check: bank name" },
        bank_branch: { type: "string", description: "bank_transfer / check: branch" },
        bank_account: { type: "string", description: "bank_transfer / check: account number" },
        reference: { type: "string", description: "bank_transfer: reference number; check: check number" },
        send_to_customer: { type: "boolean", description: "Email the receipt to the customer. Default false." },
      },
      required: ["customer_name", "amount", "payment_method"],
    },
  },
  {
    name: "mark_handled",
    description:
      "Mark a SmartBee document as handled/closed (e.g. a quote the customer accepted), or reopen it. " +
      "Identify it by the document number shown on the PDF; add doc_type if numbers may repeat across types. Confirm with the user first.",
    inputSchema: {
      type: "object",
      properties: {
        document_number: { type: "number" },
        doc_type: { type: "string", enum: ["PriceProposal", "Invoice", "InvoiceReceipt", "Receipt", "DealInvoice", "RefundInvoice", "ReceiptRefund", "OrderConfirmation", "ShippingCertificate", "DonationReceipt", "ReturnCertificate"] },
        handled: { type: "boolean", description: "true = close (default), false = reopen" },
      },
      required: ["document_number"],
    },
  },
  {
    name: "summarize_period",
    description:
      "Business summary of SmartBee documents in a date range: count and totals by document type and by customer. " +
      "Use for 'how much did I quote this month', 'who are my customers this month'. Read-only. Default range: current month.",
    inputSchema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "ISO date. Default: first day of current month" },
        to_date: { type: "string", description: "ISO date. Default: now" },
        doc_type: { type: "string", enum: ["PriceProposal", "Invoice", "InvoiceReceipt", "Receipt", "DealInvoice", "RefundInvoice", "ReceiptRefund", "OrderConfirmation", "ShippingCertificate", "DonationReceipt", "ReturnCertificate"] },
      },
    },
  },
  {
    name: "search_expenses",
    description:
      "Summarize business expenses recorded in SmartBee for a date range: total, totals by expense type, and the 10 most recent. " +
      "Use for 'how much did I spend this month / on fuel'. Read-only. Default range: current month.",
    inputSchema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "ISO date. Default: first day of current month" },
        to_date: { type: "string", description: "ISO date. Default: now" },
      },
    },
  },
  {
    name: "get_document_status",
    description: "Only for a document that create_quote just returned as 'pending': checks it by msgId. For anything else use search_documents.",
    inputSchema: {
      type: "object",
      properties: { msg_id: { type: "string" } },
      required: ["msg_id"],
    },
  },
];

interface QuoteArgs {
  customer_name: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_city?: string;
  items: { description: string; quantity: number; price: number; vat_included?: boolean }[];
  comments?: string;
  send_to_customer?: boolean;
}

async function callTool(env: SmartBeeEnv, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "list_capabilities") return CAPABILITIES;
  if (name === "create_quote") {
    const a = args as unknown as QuoteArgs;
    const customer: Customer = {
      name: a.customer_name,
      providerCustomerId: a.customer_email?.trim().toLowerCase() || undefined,
      email: a.customer_email || undefined,
      mainPhone: a.customer_phone || undefined,
      address: a.customer_address || undefined,
      cityName: a.customer_city || undefined,
    };
    const paymentItems: PaymentItem[] = (a.items ?? []).map((i) => ({
      description: i.description,
      quantity: i.quantity,
      pricePerUnit: i.price,
      vatOption: i.vat_included === false ? "NotInclude" : "Include",
    }));
    return createSmartBeeDocument(env, {
      docType: "PriceProposal",
      customer,
      documentItems: { paymentItems },
      comments: a.comments,
      creationMetadata: { sendOriginalToCustomer: a.send_to_customer === true },
    });
  }
  if (name === "search_documents") {
    const results = await searchDocuments(env, {
      customerName: args.customer_name as string | undefined,
      docType: args.doc_type as any,
      documentNumber: args.document_number as number | undefined,
      fromDate: args.from_date as string | undefined,
      toDate: args.to_date as string | undefined,
      limit: args.limit as number | undefined,
    });
    return results.length ? results : { results: [], note: "No matching documents found." };
  }
  if (name === "create_receipt") return createReceipt(env, args);
  if (name === "mark_handled") {
    const id = await findDocumentId(env, Number(args.document_number), args.doc_type as DocumentType | undefined);
    return setDocumentHandled(env, id, args.handled !== false);
  }
  if (name === "summarize_period") {
    return summarizeDocuments(env, {
      fromDate: (args.from_date as string) || monthStart(),
      toDate: (args.to_date as string) || undefined,
      docType: args.doc_type as DocumentType | undefined,
    });
  }
  if (name === "search_expenses") {
    return searchExpenses(env, {
      fromDate: (args.from_date as string) || monthStart(),
      toDate: (args.to_date as string) || undefined,
    });
  }
  if (name === "get_document_status") {
    return getDocumentStatus(env, String(args.msg_id));
  }
  throw new Error(`Unknown tool: ${name}`);
}

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

const OTHER_LABELS: Record<string, string> = { bit: "Bit", paybox: "PayBox", other: "Other" };

async function createReceipt(env: SmartBeeEnv, a: Record<string, any>) {
  const amount = Number(a.amount);
  if (!(amount > 0)) throw new Error("amount must be a positive number");
  const date = a.payment_date ? new Date(a.payment_date).toISOString() : new Date().toISOString();
  const method = String(a.payment_method);
  const need = (...keys: string[]) => {
    const missing = keys.filter((k) => !a[k]);
    if (missing.length) throw new Error(`${method} requires: ${missing.join(", ")}`);
  };

  const receiptDetails: ReceiptDetailsRequest = {};
  switch (method) {
    case "cash":
      receiptDetails.cashItems = [{ date, sum: amount }];
      break;
    case "bit":
    case "paybox":
    case "other":
      receiptDetails.otherItems = [{ description: OTHER_LABELS[method], date, sum: amount }];
      break;
    case "credit_card":
      need("card_last_digits");
      receiptDetails.creditCardItems = [{
        creditCardType: "Other",
        cardNumber: String(a.card_last_digits).slice(-4),
        creditDealType: "Regular",
        installmentsNumber: 1,
        date,
        sum: amount,
      }];
      break;
    case "bank_transfer":
      need("bank_name", "bank_branch", "bank_account", "reference");
      receiptDetails.wireTransferItems = [{
        bankName: a.bank_name, branchName: String(a.bank_branch), accountNumber: String(a.bank_account),
        referenceNum: String(a.reference), date, sum: amount,
      }];
      break;
    case "check":
      need("bank_name", "bank_branch", "bank_account", "reference");
      receiptDetails.checkItems = [{
        bankName: a.bank_name, branchName: String(a.bank_branch), accountNumber: String(a.bank_account),
        checkId: String(a.reference), date, sum: amount,
      }];
      break;
    default:
      throw new Error(`Unknown payment_method: ${method}`);
  }

  const customer: Customer = {
    name: a.customer_name,
    providerCustomerId: a.customer_email ? String(a.customer_email).trim().toLowerCase() : undefined,
    email: a.customer_email || undefined,
    mainPhone: a.customer_phone || undefined,
  };

  return createSmartBeeDocument(env, {
    docType: "Receipt",
    customer,
    receiptDetails,
    comments: a.description,
    creationMetadata: { sendOriginalToCustomer: a.send_to_customer === true },
  });
}

type RpcMsg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

const rpcResult = (id: RpcMsg["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcMsg["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(env: SmartBeeEnv, msg: RpcMsg): Promise<object | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: msg.params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      try {
        const out = await callTool(env, msg.params?.name, msg.params?.arguments ?? {});
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        return rpcResult(id, { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: SmartBeeEnv & { MCP_TOKEN?: string }, token: string): Promise<Response> {
  if (!env.MCP_TOKEN || token !== env.MCP_TOKEN) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });

  let body: RpcMsg | RpcMsg[];
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  if (Array.isArray(body)) {
    const results = (await Promise.all(body.map((m) => handleRpc(env, m)))).filter(Boolean);
    return results.length ? Response.json(results) : new Response(null, { status: 202 });
  }
  const result = await handleRpc(env, body);
  return result ? Response.json(result) : new Response(null, { status: 202 });
}
