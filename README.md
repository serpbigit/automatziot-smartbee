# automatziot-smartbee

A Cloudflare Worker that creates SmartBee documents (quotes, invoices, receipts)
via SmartBee's REST API. Part of the Automatziot Factory.

Licensed under the [PolyForm Internal Use License 1.0.0](LICENSE) — you may
deploy and run your own copy for your own business, but may not redistribute
or resell it.

## Local development

```
npm install
npm run dev
```

## Deploying

Deploys run automatically via GitHub Actions (`.github/workflows/deploy.yml`)
on push to `main`, or manually from the Actions tab.

Required repository secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` — for deploying the Worker
- `SMARTBEE_CLIENT_ID` / `SMARTBEE_PASSWORD` — SmartBee API client credentials
- `PROVIDERUSERTOKEN` — SmartBee provider user token

These are also pushed into the Worker's own runtime secrets on every deploy
(via `wrangler secret put`), since the Worker needs them at request time to
call SmartBee's API, not just at deploy time.

## API

`POST /documents` — creates a SmartBee document. Body is a
`SmartBeeDocumentRequest` (see `src/types/smartbee.ts`): `customer`, `docType`
(`PriceProposal`, `Invoice`, `DealInvoice`, `Receipt`, etc.), and optionally
`documentItems` with line items. Returns SmartBee's response, including
`linkToOriginal`/`linkToCopy` PDF URLs on success.
