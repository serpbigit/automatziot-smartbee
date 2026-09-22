import { createSmartBeeDocument, type SmartBeeEnv } from "./smartbee-client";
import type { SmartBeeDocumentRequest } from "./types/smartbee";

export interface Env extends SmartBeeEnv {
  LICENSE_KEY?: string;
}

async function isLicenseValid(env: Env): Promise<boolean> {
  try {
    const response = await fetch("https://api.automatziot.com/v1/verify-license", {
      headers: env.LICENSE_KEY ? { Authorization: `Bearer ${env.LICENSE_KEY}` } : {},
    });
    return response.status !== 402;
  } catch {
    // Endpoint doesn't exist yet — allow through so testing isn't blocked.
    return true;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await isLicenseValid(env))) {
      return new Response("Payment Required", { status: 402 });
    }

    const url = new URL(request.url);

    // TEMPORARY — remove once secret corruption is ruled out. Never returns
    // the actual secret values, only length/whitespace metadata.
    if (url.pathname === "/debug/secrets") {
      const describe = (v: string | undefined) => ({
        present: typeof v === "string" && v.length > 0,
        length: v?.length ?? 0,
        hasLeadingWhitespace: !!v && v !== v.trimStart(),
        hasTrailingWhitespace: !!v && v !== v.trimEnd(),
      });
      return Response.json({
        SMARTBEE_CLIENT_ID: describe(env.SMARTBEE_CLIENT_ID),
        SMARTBEE_PASSWORD: describe(env.SMARTBEE_PASSWORD),
        PROVIDERUSERTOKEN: describe(env.PROVIDERUSERTOKEN),
      });
    }

    if (request.method === "POST" && url.pathname === "/documents") {
      const body = (await request.json()) as SmartBeeDocumentRequest;
      try {
        const result = await createSmartBeeDocument(env, body);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    }

    return new Response("Automatziot SmartBee Worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
