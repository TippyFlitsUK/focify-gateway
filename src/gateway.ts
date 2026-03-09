/**
 * IPFS gateway backed by FOC SP trustless gateways.
 *
 * On first request for a CID, probes all SP gateways to find which one has it.
 * Pins that CID to the responding gateway for all subsequent block fetches.
 * No full DAG prefetch -- streams blocks on demand from the pinned gateway.
 */

import { createHeliaHTTP } from "@helia/http"
import { trustlessGateway } from "@helia/block-brokers"
import { httpGatewayRouting } from "@helia/routers"
import { unixfs, type UnixFS } from "@helia/unixfs"
import { CID } from "multiformats/cid"
import type { Helia } from "@helia/http"
import type { ProviderRegistry } from "./providers.js"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
}

function getMimeType(path: string): string {
  const ext = path.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ""
  return MIME_TYPES[ext] || "application/octet-stream"
}

// Cache: CID string -> { gatewayURL, helia instance, unixfs }
interface CIDRoute {
  gatewayURL: string
  helia: Helia
  fs: UnixFS
  lastAccess: number
}

// Evict routes not accessed in 30 minutes
const ROUTE_TTL_MS = 30 * 60 * 1000
const EVICTION_INTERVAL_MS = 5 * 60 * 1000

export class Gateway {
  private registry: ProviderRegistry
  private routes = new Map<string, CIDRoute>()
  private probing = new Map<string, Promise<CIDRoute | null>>()
  private evictionTimer: ReturnType<typeof setInterval> | null = null

  constructor(registry: ProviderRegistry) {
    this.registry = registry
  }

  async start(): Promise<void> {
    this.evictionTimer = setInterval(() => this.evictStale(), EVICTION_INTERVAL_MS)
    console.log("[gateway] Ready (route-per-CID mode)")
  }

  /**
   * Probe all SP gateways to find which one has a CID.
   * Returns the first gateway URL that responds with a valid block.
   */
  private async probeForCID(cid: CID): Promise<string | null> {
    const gateways = this.registry.getGatewayURLs()
    if (gateways.length === 0) return null

    // Deduplicate URLs (e.g., multiple storacha entries)
    const unique = [...new Set(gateways)]

    console.log(`[gateway] Probing ${unique.length} gateways for ${cid.toString().slice(0, 16)}...`)

    // Race all gateways -- request the root block as CAR
    const controller = new AbortController()

    const probes = unique.map(async (url) => {
      try {
        const resp = await fetch(
          `${url}/ipfs/${cid.toString()}?format=car&dag-scope=block`,
          {
            headers: { Accept: "application/vnd.ipld.car" },
            signal: controller.signal,
          }
        )
        if (resp.ok) {
          // Consume and discard the body to free the connection
          await resp.arrayBuffer()
          return url
        }
        // Consume error body too
        await resp.arrayBuffer().catch(() => {})
        return null
      } catch {
        return null
      }
    })

    // Take the first successful result
    try {
      const result = await Promise.any(
        probes.map(async (p) => {
          const url = await p
          if (url) return url
          throw new Error("not found")
        })
      )
      controller.abort()
      console.log(`[gateway] Found ${cid.toString().slice(0, 16)}... at ${result}`)
      return result
    } catch {
      console.log(`[gateway] No gateway has ${cid.toString().slice(0, 16)}...`)
      return null
    }
  }

  /**
   * Get or create a Helia instance pinned to the gateway that has this CID.
   */
  private async getRoute(cid: CID): Promise<CIDRoute | null> {
    const cidStr = cid.toString()

    // Check cache
    const cached = this.routes.get(cidStr)
    if (cached) {
      cached.lastAccess = Date.now()
      return cached
    }

    // Deduplicate concurrent probes for the same CID
    const existing = this.probing.get(cidStr)
    if (existing) return existing

    const probe = (async () => {
      const gatewayURL = await this.probeForCID(cid)
      if (!gatewayURL) return null

      // Create a Helia instance pinned to this single gateway
      const helia = await createHeliaHTTP({
        blockBrokers: [trustlessGateway()],
        routers: [httpGatewayRouting({ gateways: [gatewayURL] })],
      })

      const route: CIDRoute = {
        gatewayURL,
        helia,
        fs: unixfs(helia),
        lastAccess: Date.now(),
      }

      this.routes.set(cidStr, route)
      return route
    })()

    this.probing.set(cidStr, probe)
    try {
      return await probe
    } finally {
      this.probing.delete(cidStr)
    }
  }

  /**
   * Fetch content for an IPFS path and write it to the HTTP response.
   */
  async serve(
    cidStr: string,
    path: string,
    res: {
      writeHead: (code: number, headers: Record<string, string>) => void
      end: (data?: Uint8Array | string) => void
    }
  ): Promise<void> {
    let cid: CID
    try {
      cid = CID.parse(cidStr)
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" })
      res.end("Invalid CID")
      return
    }

    const route = await this.getRoute(cid)
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("Content not found on any FOC provider")
      return
    }

    const fullPath = path || ""

    try {
      const chunks: Uint8Array[] = []
      let servePath = fullPath

      // If path is empty or ends with /, try index.html
      if (!servePath || servePath.endsWith("/")) {
        servePath = servePath + "index.html"
      }

      try {
        for await (const chunk of route.fs.cat(cid, {
          path: servePath || undefined,
        })) {
          chunks.push(chunk)
        }
      } catch (catError: any) {
        // If the exact path failed and doesn't have an extension, try with /index.html
        if (!servePath.includes(".")) {
          const indexPath = servePath.replace(/\/?$/, "/index.html")
          for await (const chunk of route.fs.cat(cid, { path: indexPath })) {
            chunks.push(chunk)
          }
          servePath = indexPath
        } else {
          throw catError
        }
      }

      // Merge chunks
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
      const body = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.length
      }

      const contentType = getMimeType(servePath)
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-FOC-Provider": route.gatewayURL,
      })
      res.end(body)
    } catch (err: any) {
      console.error(`[gateway] Error serving ${cidStr}/${fullPath}:`, err.message)
      // Invalidate cached route so next request re-probes
      // (CID may not have been available yet when the route was created)
      this.routes.delete(cidStr)
      route.helia.stop().catch(() => {})
      console.log(`[gateway] Evicted failed route for ${cidStr.slice(0, 16)}... (will re-probe on next request)`)
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end(`Failed to fetch content: ${err.message}`)
    }
  }

  private evictStale(): void {
    const now = Date.now()
    let evicted = 0
    for (const [cidStr, route] of this.routes) {
      if (now - route.lastAccess > ROUTE_TTL_MS) {
        route.helia.stop().catch(() => {})
        this.routes.delete(cidStr)
        evicted++
      }
    }
    if (evicted > 0) {
      console.log(`[gateway] Evicted ${evicted} stale route(s), ${this.routes.size} cached`)
    }
  }

  async stop(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer)
      this.evictionTimer = null
    }
    for (const [, route] of this.routes) {
      await route.helia.stop().catch(() => {})
    }
    this.routes.clear()
  }
}
