# focify-gateway

IPFS gateway and routing provider for Filecoin Onchain Cloud (FOC) content. Serves websites stored on FOC storage providers without depending on cid.contact, eth.limo, or any external IPNI/routing infrastructure.

## What This Does

Two services in one:

1. **IPFS Gateway** -- `gateway.focify.me/ipfs/{CID}` fetches content directly from FOC SP trustless gateways and serves rendered HTML/CSS/JS/images
2. **Routing Provider** -- `gateway.focify.me/routing/v1/providers/{CID}` implements the IPFS Delegated Routing protocol so any IPFS gateway can discover FOC content

## Architecture

```
Request -> focify-gateway -> SP Registry contract (provider discovery via viem)
                          -> FOC SP trustless gateways (content fetch)
                          -> Helia HTTP (CAR deserialization + UnixFS)
                          -> HTTP response
```

**Provider discovery:** Queries the on-chain ServiceProviderRegistry contract via Filecoin RPC (viem). Calls `getAllActiveProviders()` to get IDs, then `getProviderWithProduct()` for each to extract `serviceURL` from PDP product capabilities. All 27 active mainnet providers discovered dynamically. Refreshes every 10 minutes.

**Content serving:** Uses `@helia/http` with `trustlessGateway()` block broker and `httpGatewayRouting()` pointed at all discovered SP `serviceURL`s. `@helia/unixfs` deserializes content. Serves with correct MIME types and immutable cache headers.

**Routing:** Implements `/routing/v1/providers/{CID}` per IPFS HTTP Routing V1 spec. Returns all known FOC provider records so any IPFS gateway can discover FOC content without cid.contact.

## Key Dependencies

- `@helia/http` -- lightweight IPFS client (no full node)
- `@helia/unixfs` -- UnixFS file extraction
- `@helia/block-brokers` -- trustless gateway block fetching
- `@helia/routers` -- HTTP gateway routing
- `viem` -- Filecoin RPC for SP Registry contract queries
- `multiformats` -- CID handling

## Provider Discovery

- **Source:** On-chain ServiceProviderRegistry contract
  - Mainnet: `0xf55dDbf63F1b55c3F1D4FA7e339a68AB7b64A5eB`
  - Calibnet: `0x839e5c9988e4e9977d40708d0094103c0839Ac9D`
  - (Mainnet address discovered from FWSS contract `0x8408502033c418e1bbc97ce9ac48e5528f371a9f`)
- **Method:** `getAllActiveProviders()` -> `getProviderWithProduct(id, 0)` -> decode `serviceURL` from capability values
- **Data:** `serviceURL` is first capability key in PDP product (`capabilityKeys[0]`), value is hex-encoded URL in `productCapabilityValues[0]`
- **Refresh:** Every 10 minutes
- **Cross-reference:** Goldsky subgraph available for activity stats
  - Mainnet: `https://api.goldsky.com/api/public/project_cmdfaaxeuz6us01u359yjdctw/subgraphs/pdp-explorer/mainnet311a/gn`
  - Calibnet: `https://api.goldsky.com/api/public/project_cmdfaaxeuz6us01u359yjdctw/subgraphs/pdp-explorer/calibration311a/gn`

## Endpoints

- `GET /ipfs/{CID}` -- serve root content (auto-resolves index.html)
- `GET /ipfs/{CID}/path/to/file` -- serve specific file
- `GET /routing/v1/providers/{CID}` -- delegated routing (IPFS HTTP Routing V1)
- `GET /health` -- health check with provider count and gateway URLs
- `GET /` -- usage info

## Deployment

- Target: 77.42.75.71 (filoz-dealbot server)
- Domain: gateway.focify.me
- Runtime: Node.js + PM2
- Reverse proxy: nginx

## Development

```bash
npm install
npm run build
npm start          # production (port 8090)
npm run dev        # development with tsx watch
```

Environment variables:
- `PORT` -- HTTP port (default: 8090)
- `NETWORK` -- `mainnet` or `calibration` (default: mainnet)

## Caching

Route-per-CID: first request probes all SP gateways, pins CID to the first responder, caches for 30 minutes. On any serve error (e.g. "Failed to load block"), the cached route is evicted and the Helia instance stopped -- next request re-probes fresh. This prevents negative caching when a CID is requested before content is published.

## Stack

- TypeScript, ES modules, Node.js
- viem for contract reads (same as synapse-sdk)
- Helia HTTP for IPFS content serving
- No semicolons (match synapse-sdk style)

## ABI Notes

The SP Registry `getProviderWithProduct` returns:
- `providerInfo.serviceProvider` -- provider wallet address
- `providerInfo.name` -- provider name
- `product.capabilityKeys` -- `string[]` (NOT bytes32)
- `productCapabilityValues` -- `bytes[]` (hex-encoded values)
- `serviceURL` = `hexToString(productCapabilityValues[indexOf('serviceURL')])`

ethers v6 cannot decode this complex tuple (deferred ABI decoding errors). Use viem.
