/**
 * focify-gateway -- IPFS gateway + routing provider for FOC content.
 *
 * Endpoints:
 *   GET /ipfs/:cid/*path     -- Serve IPFS content (HTML/CSS/JS/images)
 *   GET /routing/v1/providers/:cid -- IPFS Delegated Routing (HTTP Routing V1)
 *   GET /health               -- Health check
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { ProviderRegistry, type Network } from "./providers.js"
import { Gateway } from "./gateway.js"

const PORT = parseInt(process.env.PORT || "8090", 10)
const NETWORK = (process.env.NETWORK || "mainnet") as Network
const GATEWAY_DOMAIN = process.env.GATEWAY_DOMAIN || "gateway.focify.me"

async function main(): Promise<void> {
  console.log("=== focify-gateway ===")
  console.log(`Network: ${NETWORK}`)
  console.log(`Port:    ${PORT}`)
  console.log("")

  // 1. Discover providers
  const registry = new ProviderRegistry(NETWORK)
  await registry.start()

  // 2. Start gateway
  const gateway = new Gateway(registry)
  await gateway.start()

  // 3. HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`)
    const pathname = url.pathname
    const host = req.headers.host || ""

    try {
      // Subdomain gateway: {CID}.gateway.focify.me
      const hostName = host.split(":")[0]
      const suffix = `.${GATEWAY_DOMAIN.split(":")[0]}`
      if (hostName !== GATEWAY_DOMAIN.split(":")[0] && hostName.endsWith(suffix)) {
        const cidStr = hostName.slice(0, -suffix.length)
        const path = pathname === "/" ? "" : pathname.slice(1)

        if (!cidStr) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Missing CID in subdomain")
          return
        }

        console.log(`[http] GET ${cidStr}.ipfs.../${path}`)
        await gateway.serve(cidStr, path, res)
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

        console.log(`[http] GET /ipfs/${cidStr}/${path}`)
        await gateway.serve(cidStr, path, res)
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

      // /health
      if (pathname === "/health") {
        const providers = registry.getProviders()
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            status: "ok",
            network: NETWORK,
            providers: providers.length,
            gatewayURLs: registry.getGatewayURLs(),
          })
        )
        return
      }

      // Root
      if (pathname === "/") {
        const providers = registry.getProviders()
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end(
          [
            "focify-gateway",
            `Network: ${NETWORK}`,
            `Providers: ${providers.length}`,
            "",
            "Usage:",
            "  GET /ipfs/{CID}             -- Serve IPFS content",
            "  GET /ipfs/{CID}/path/file   -- Serve specific file",
            "  GET /routing/v1/providers/{CID} -- Delegated routing",
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
    console.log(`\n[http] Listening on http://0.0.0.0:${PORT}`)
    console.log(`[http] Try: http://localhost:${PORT}/health`)
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[shutdown] Stopping...")
    registry.stop()
    await gateway.stop()
    server.close()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
