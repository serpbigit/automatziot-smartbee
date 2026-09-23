// Minimal stateless MCP server (Streamable HTTP, JSON responses) for Claude custom connectors.
// Route: POST /mcp/<MCP_TOKEN>. Disabled entirely if MCP_TOKEN is not set.
import { createSmartBeeDocument, getDocumentStatus, type SmartBeeEnv } from "./smartbee-client";
import type { Customer, PaymentItem } from "./types/smartbee";

const SERVER_INFO = { name: "automatziot-smartbee", version: "0.2.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

const TOOLS = [
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
    name: "get_document_status",
    description: "Check a SmartBee document that create_quote returned as pending, using its msgId.",
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
  if (name === "get_document_status") {
    return getDocumentStatus(env, String(args.msg_id));
  }
  throw new Error(`Unknown tool: ${name}`);
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
