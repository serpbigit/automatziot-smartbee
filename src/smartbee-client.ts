import type {
  SmartBeeApiResponse,
  SmartBeeDocumentCreateResponse,
  SmartBeeDocumentRequest,
} from "./types/smartbee";

const SMARTBEE_BASE_URL = "https://test.smartbee.co.il/api/v1";

export interface SmartBeeEnv {
  SMARTBEE_CLIENT_ID: string;
  SMARTBEE_PASSWORD: string;
  PROVIDERUSERTOKEN: string;
}

interface AuthenticationResponse {
  token: string;
  expirationUtcDate: string;
}

interface SBUserLoginTokenResponse {
  token: string;
  expirationTime: string;
}

async function authenticateClient(env: SmartBeeEnv): Promise<string> {
  const res = await fetch(`${SMARTBEE_BASE_URL}/Login/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: env.SMARTBEE_CLIENT_ID,
      password: env.SMARTBEE_PASSWORD,
    }),
  });
  if (!res.ok) {
    throw new Error(`SmartBee client auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as AuthenticationResponse;
  return data.token;
}

async function authenticateUser(env: SmartBeeEnv, clientToken: string): Promise<string> {
  const res = await fetch(`${SMARTBEE_BASE_URL}/Users/loginToken`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${clientToken}`,
    },
    body: JSON.stringify({ providerUserToken: env.PROVIDERUSERTOKEN }),
  });
  if (!res.ok) {
    throw new Error(`SmartBee user auth failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as SmartBeeApiResponse<SBUserLoginTokenResponse>;
  return data.result.token;
}

export async function createSmartBeeDocument(
  env: SmartBeeEnv,
  request: SmartBeeDocumentRequest,
): Promise<SmartBeeDocumentCreateResponse> {
  const clientToken = await authenticateClient(env);
  const userToken = await authenticateUser(env, clientToken);

  const fullRequest = {
    ...request,
    providerUserToken: env.PROVIDERUSERTOKEN,
    providerMsgId: crypto.randomUUID(),
    providerMsgReferenceId: crypto.randomUUID(),
  };

  const res = await fetch(`${SMARTBEE_BASE_URL}/Documents/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify(fullRequest),
  });

  const data = (await res.json()) as SmartBeeApiResponse<SmartBeeDocumentCreateResponse>;
  if (!res.ok) {
    throw new Error(`SmartBee document creation failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.result;
}
