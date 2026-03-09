/**
 * focify-gateway -- IPFS gateway + routing provider for FOC content.
 *
 * Endpoints:
 *   GET /ipfs/:cid/*path     -- Serve IPFS content (HTML/CSS/JS/images)
 *   GET /routing/v1/providers/:cid -- IPFS Delegated Routing (HTTP Routing V1)
 *   GET /health               -- Health check
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createHTTPSServer } from "node:https"
import { readFileSync } from "node:fs"
import { ProviderRegistry, type Network } from "./providers.js"
import { Gateway } from "./gateway.js"

const PORT = parseInt(process.env.PORT || "8090", 10)
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "443", 10)
const NETWORKS: Network[] = ["mainnet", "calibration"]
const GATEWAY_DOMAIN = process.env.GATEWAY_DOMAIN || "gateway.focify.me"
const TLS_CERT = process.env.TLS_CERT || "/etc/letsencrypt/live/gateway.focify.me/fullchain.pem"
const TLS_KEY = process.env.TLS_KEY || "/etc/letsencrypt/live/gateway.focify.me/privkey.pem"

async function main(): Promise<void> {
  console.log("=== focify-gateway ===")
  console.log(`Networks: ${NETWORKS.join(", ")}`)
  console.log(`Port:     ${PORT}`)
  console.log("")

  // 1. Discover providers on both networks
  const registries = new Map<Network, ProviderRegistry>()
  const gateways = new Map<Network, Gateway>()

  for (const network of NETWORKS) {
    const registry = new ProviderRegistry(network)
    await registry.start()
    registries.set(network, registry)

    const gw = new Gateway(registry)
    await gw.start()
    gateways.set(network, gw)
    console.log(`[${network}] Ready`)
  }

  // Default registry/gateway for routing and pieces endpoints
  const registry = registries.get("mainnet")!
  const gateway = gateways.get("mainnet")!

  // CID -> network cache: remember which network successfully served a CID
  const cidNetworkCache = new Map<string, Network>()

  // Try cached network first, then all networks in order
  async function serveWithFallback(
    cidStr: string,
    path: string,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    // Try cached network first
    const cached = cidNetworkCache.get(cidStr)
    if (cached) {
      const gw = gateways.get(cached)!
      const served = await gw.tryServe(cidStr, path, res)
      if (served) return
      // Cache miss (route evicted or content gone) -- clear and fall through
      cidNetworkCache.delete(cidStr)
    }

    // Try all networks in order
    for (const network of NETWORKS) {
      if (network === cached) continue // already tried
      const gw = gateways.get(network)!
      const served = await gw.tryServe(cidStr, path, res)
      if (served) {
        cidNetworkCache.set(cidStr, network)
        return
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("Content not found on any FOC provider (mainnet + calibration)")
  }

  // 3. HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`)
    const pathname = url.pathname
    const host = req.headers.host || ""

    try {
      // Subdomain gateway: {CID}.ipfs.gateway.focify.me
      const hostName = host.split(":")[0]
      const ipfsSuffix = `.ipfs.${GATEWAY_DOMAIN.split(":")[0]}`
      if (hostName.endsWith(ipfsSuffix)) {
        const cidStr = hostName.slice(0, -ipfsSuffix.length)
        const path = pathname === "/" ? "" : pathname.slice(1)

        if (!cidStr) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Missing CID in subdomain")
          return
        }

        console.log(`[http] GET ${cidStr}.ipfs.../${path}`)
        await serveWithFallback(cidStr, path, res)
        return
      }

      // /ipfs/:cid or /ipfs/:cid/path/to/file
      if (pathname.startsWith("/ipfs/")) {
        const rest = pathname.slice(6) // after "/ipfs/"
        const slashIdx = rest.indexOf("/")
        const cidStr = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
        const path = slashIdx === -1 ? "" : rest.slice(slashIdx + 1)

        if (!cidStr) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Missing CID")
          return
        }

        // Redirect to subdomain gateway so absolute paths work
        // Unless CID exceeds 63-char DNS label limit
        if (cidStr.length <= 63) {
          const subdomain = `${cidStr}.ipfs.${GATEWAY_DOMAIN.split(":")[0]}`
          const redirectURL = `https://${subdomain}/${path}`
          console.log(`[http] Redirect /ipfs/${cidStr.slice(0, 16)}.../ -> subdomain`)
          res.writeHead(302, { Location: redirectURL })
          res.end()
          return
        }

        // Long CID: serve directly from path (subdomain would break DNS)
        console.log(`[http] GET /ipfs/${cidStr.slice(0, 16)}.../${path}`)
        await serveWithFallback(cidStr, path, res)
        return
      }

      // /routing/v1/providers/:cid -- Delegated Routing
      if (pathname.startsWith("/routing/v1/providers/")) {
        const cidStr = pathname.slice(21) // after "/routing/v1/providers/"
        if (!cidStr) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Missing CID" }))
          return
        }

        console.log(`[http] GET /routing/v1/providers/${cidStr}`)

        // Return all known FOC provider records
        // In a full implementation, we'd check the subgraph for which providers
        // actually have this specific CID. For now, return all active providers
        // and let the requesting gateway try them.
        const providers = registry.getProviders()
        const records = providers.map((p) => ({
          Protocol: "transport-ipfs-gateway-http",
          Schema: "peer",
          ID: p.address,
          Addrs: [p.serviceURL],
          Metadata: { name: p.name },
        }))

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        })
        res.end(JSON.stringify({ Providers: records }))
        return
      }

      // /provider/:id/pieces -- List all pieces stored by a provider
      if (pathname.startsWith("/provider/") && pathname.endsWith("/pieces")) {
        const providerIdOrAddress = pathname.slice(10, -7) // between "/provider/" and "/pieces"
        if (!providerIdOrAddress) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Missing provider ID or address" }))
          return
        }

        const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 1000)
        const offset = parseInt(url.searchParams.get("offset") || "0", 10)

        console.log(`[http] GET /provider/${providerIdOrAddress}/pieces?limit=${limit}&offset=${offset}`)

        try {
          const result = await registry.getPiecesByProvider(providerIdOrAddress, limit, offset)
          const provider = registry.getProviders().find(
            (p) => String(p.id) === providerIdOrAddress || p.address.toLowerCase() === providerIdOrAddress.toLowerCase()
          )

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300",
          })
          res.end(JSON.stringify({
            provider: provider ? { id: provider.id, name: provider.name, address: provider.address, serviceURL: provider.serviceURL } : { query: providerIdOrAddress },
            network: "mainnet",
            totalDataSets: result.totalDataSets,
            count: result.pieces.length,
            limit,
            offset,
            pieces: result.pieces,
          }))
        } catch (err: any) {
          console.error(`[http] Error fetching pieces:`, err.message)
          res.writeHead(502, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: `Failed to query subgraph: ${err.message}` }))
        }
        return
      }

      // /health
      if (pathname === "/health") {
        const health: Record<string, unknown> = { status: "ok" }
        for (const [network, reg] of registries) {
          health[network] = { providers: reg.getProviders().length, gatewayURLs: reg.getGatewayURLs() }
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(health))
        return
      }

      // Root
      if (pathname === "/") {
        const lines = ["focify-gateway"]
        for (const [network, reg] of registries) {
          lines.push(`${network}: ${reg.getProviders().length} providers`)
        }
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end(
          [
            ...lines,
            "",
            "Usage:",
            "  GET /ipfs/{CID}             -- Serve IPFS content",
            "  GET /ipfs/{CID}/path/file   -- Serve specific file",
            "  GET /routing/v1/providers/{CID} -- Delegated routing",
            "  GET /provider/{id}/pieces   -- List pieces stored by a provider",
            "  GET /health                 -- Health check",
          ].join("\n")
        )
        return
      }

      // 404
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("Not found")
    } catch (err: any) {
      console.error("[http] Request error:", err.message)
      res.writeHead(500, { "Content-Type": "text/plain" })
      res.end("Internal server error")
    }
  })

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[http] Listening on http://0.0.0.0:${PORT}`)
  })

  // HTTPS server with Let's Encrypt cert
  try {
    const tlsOpts = {
      cert: readFileSync(TLS_CERT),
      key: readFileSync(TLS_KEY),
    }
    const httpsServer = createHTTPSServer(tlsOpts, server.listeners("request")[0] as any)
    httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
      console.log(`[https] Listening on https://0.0.0.0:${HTTPS_PORT}`)
    })
    // Graceful shutdown includes HTTPS
    const shutdown = async () => {
      console.log("\n[shutdown] Stopping...")
      for (const reg of registries.values()) reg.stop()
      for (const gw of gateways.values()) await gw.stop()
      server.close()
      httpsServer.close()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  } catch (err: any) {
    console.log(`[https] TLS not available (${err.message}), HTTP only`)
    const shutdown = async () => {
      console.log("\n[shutdown] Stopping...")
      for (const reg of registries.values()) reg.stop()
      for (const gw of gateways.values()) await gw.stop()
      server.close()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
