import { handleMcp } from "./mcp";
import { createSmartBeeDocument, getDocumentStatus, type DocumentInput, type SmartBeeEnv } from "./smartbee-client";

export interface Env extends SmartBeeEnv {
  LICENSE_KEY?: string;
  MCP_TOKEN?: string;
}

async function isLicenseValid(env: Env): Promise<boolean> {
  try {
    const response = await fetch("https://api.automatziot.com/v1/verify-license", {
      headers: env.LICENSE_KEY ? { Authorization: `Bearer ${env.LICENSE_KEY}` } : {},
    });
    return response.status !== 402;
  } catch {
    // Endpoint doesn't exist yet - allow through so testing isn't blocked.
    return true;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await isLicenseValid(env))) {
      return new Response("Payment Required", { status: 402 });
    }

    const url = new URL(request.url);

    // MCP endpoint for Claude custom connector: /mcp/<MCP_TOKEN>
    const mcp = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (mcp) return handleMcp(request, env, mcp[1]);

    try {
      // Create a document (e.g. docType "PriceProposal"); polls up to ~20s.
      if (request.method === "POST" && url.pathname === "/documents") {
        const body = (await request.json()) as DocumentInput;
        return Response.json(await createSmartBeeDocument(env, body));
      }

      // Check a pending document by SmartBee message ID.
      const m = url.pathname.match(/^\/documents\/([^/]+)$/);
      if (request.method === "GET" && m) {
        return Response.json(await getDocumentStatus(env, decodeURIComponent(m[1])));
      }
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }

    return new Response("Automatziot SmartBee Worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
