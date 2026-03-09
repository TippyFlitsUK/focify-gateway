/**
 * FOC provider discovery via Goldsky subgraph + SP Registry contract.
 *
 * 1. Get all active provider IDs from SP Registry contract (on-chain)
 * 2. For each provider, decode serviceURL from PDP product capabilities
 * 3. Cross-reference with subgraph for activity stats
 * 4. Cache and refresh every REFRESH_INTERVAL_MS
 */

import { createPublicClient, http, hexToString, type Hex } from "viem"
import { filecoin } from "viem/chains"
import { CID } from "multiformats/cid"

// SP Registry contract address (discovered from FWSS contract on mainnet)
const SP_REGISTRY_ADDRESSES = {
  mainnet: "0xf55dDbf63F1b55c3F1D4FA7e339a68AB7b64A5eB" as const,
  calibration: "0x839e5c9988e4e9977d40708d0094103c0839Ac9D" as const,
}

const RPC_URLS = {
  mainnet: "https://api.node.glif.io/rpc/v1",
  calibration: "https://api.calibration.node.glif.io/rpc/v1",
}

// Goldsky PDP Scan subgraph endpoints
const SUBGRAPH_URLS = {
  mainnet:
    "https://api.goldsky.com/api/public/project_cmdfaaxeuz6us01u359yjdctw/subgraphs/pdp-explorer/mainnet311a/gn",
  calibration:
    "https://api.goldsky.com/api/public/project_cmdfaaxeuz6us01u359yjdctw/subgraphs/pdp-explorer/calibration311a/gn",
}

// ABI fragments from synapse-core generated.ts
const SP_REGISTRY_ABI = [
  {
    type: "function" as const,
    inputs: [
      { name: "offset", type: "uint256" as const },
      { name: "limit", type: "uint256" as const },
    ],
    name: "getAllActiveProviders" as const,
    outputs: [
      { name: "providerIds", type: "uint256[]" as const },
      { name: "hasMore", type: "bool" as const },
    ],
    stateMutability: "view" as const,
  },
  {
    type: "function" as const,
    inputs: [
      { name: "providerId", type: "uint256" as const },
      { name: "productType", type: "uint8" as const },
    ],
    name: "getProviderWithProduct" as const,
    outputs: [
      {
        name: "" as const,
        type: "tuple" as const,
        components: [
          { name: "providerId", type: "uint256" as const },
          {
            name: "providerInfo",
            type: "tuple" as const,
            components: [
              { name: "serviceProvider", type: "address" as const },
              { name: "payee", type: "address" as const },
              { name: "name", type: "string" as const },
              { name: "description", type: "string" as const },
              { name: "isActive", type: "bool" as const },
            ],
          },
          {
            name: "product",
            type: "tuple" as const,
            components: [
              { name: "productType", type: "uint8" as const },
              { name: "capabilityKeys", type: "string[]" as const },
              { name: "isActive", type: "bool" as const },
            ],
          },
          { name: "productCapabilityValues", type: "bytes[]" as const },
        ],
      },
    ],
    stateMutability: "view" as const,
  },
] as const

const REFRESH_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

export interface ProviderGateway {
  id: number
  address: string
  serviceURL: string
  name: string
  description: string
}

export type Network = "mainnet" | "calibration"

export class ProviderRegistry {
  private providers: ProviderGateway[] = []
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private network: Network

  constructor(network: Network = "mainnet") {
    this.network = network
  }

  async start(): Promise<void> {
    console.log(`[providers] Discovering FOC providers on ${this.network}...`)
    await this.refresh()
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) =>
        console.error("[providers] Refresh failed:", err.message)
      )
    }, REFRESH_INTERVAL_MS)
    console.log(
      `[providers] Will refresh every ${REFRESH_INTERVAL_MS / 60000} minutes`
    )
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  getProviders(): ProviderGateway[] {
    return this.providers
  }

  getGatewayURLs(): string[] {
    return this.providers.map((p) => p.serviceURL).filter(Boolean)
  }

  getNetwork(): Network {
    return this.network
  }

  /**
   * Query the Goldsky subgraph for all pieces (roots) stored by a provider.
   * Looks up by provider ID (from SP Registry) or address.
   */
  async getPiecesByProvider(
    providerIdOrAddress: string,
    limit = 100,
    offset = 0
  ): Promise<{ pieces: { cid: string; rawSize: string; setId: string }[]; totalDataSets: number }> {
    // Find the provider address
    let address: string
    const byId = this.providers.find(
      (p) => String(p.id) === providerIdOrAddress
    )
    if (byId) {
      address = byId.address.toLowerCase()
    } else {
      address = providerIdOrAddress.toLowerCase()
    }

    const subgraphURL = SUBGRAPH_URLS[this.network]

    // 1. Get all datasets owned by this provider
    const dsResp = await fetch(subgraphURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ dataSets(first: 1000, where: { owner: "${address}" }) { setId isActive } }`,
      }),
    })
    const dsData = (await dsResp.json()) as any
    const dataSets: { setId: string; isActive: boolean }[] =
      dsData?.data?.dataSets || []

    const activeSets = dataSets.filter((ds) => ds.isActive)
    if (activeSets.length === 0)
      return { pieces: [], totalDataSets: 0 }

    // 2. Get roots with pagination across all active datasets
    // Query all datasets at once using OR, with skip/limit
    const setIds = activeSets.map((ds) => `"${ds.setId}"`).join(",")
    const rootResp = await fetch(subgraphURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ roots(first: ${limit}, skip: ${offset}, where: { setId_in: [${setIds}], removed: false }, orderBy: rootId) { cid rawSize setId } }`,
      }),
    })
    const rootData = (await rootResp.json()) as any
    const roots: { cid: string; rawSize: string; setId: string }[] =
      rootData?.data?.roots || []

    const pieces: { cid: string; rawSize: string; setId: string }[] = []
    for (const root of roots) {
      try {
        const hex = root.cid.startsWith("0x")
          ? root.cid.slice(2)
          : root.cid
        const bytes = Uint8Array.from(Buffer.from(hex, "hex"))
        const decoded = CID.decode(bytes)
        pieces.push({
          cid: decoded.toString(),
          rawSize: root.rawSize,
          setId: root.setId,
        })
      } catch {
        // Skip malformed CIDs
      }
    }

    return { pieces, totalDataSets: activeSets.length }
  }

  private async refresh(): Promise<void> {
    const client = createPublicClient({
      chain: this.network === "mainnet" ? filecoin : undefined,
      transport: http(RPC_URLS[this.network]),
    })

    const registryAddress = SP_REGISTRY_ADDRESSES[this.network]

    // 1. Get all active provider IDs
    const [providerIds] = await client.readContract({
      address: registryAddress,
      abi: SP_REGISTRY_ABI,
      functionName: "getAllActiveProviders",
      args: [0n, 100n],
    })

    console.log(
      `[providers] Found ${providerIds.length} active providers on-chain`
    )

    // 2. Resolve each provider's serviceURL
    const resolved: ProviderGateway[] = []

    // Batch in groups of 5 to avoid RPC rate limits
    const batchSize = 5
    for (let i = 0; i < providerIds.length; i += batchSize) {
      const batch = providerIds.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          const result = await client.readContract({
            address: registryAddress,
            abi: SP_REGISTRY_ABI,
            functionName: "getProviderWithProduct",
            args: [id, 0], // 0 = PDP product type
          })
          return { id: Number(id), data: result }
        })
      )

      for (const result of results) {
        if (result.status !== "fulfilled") continue
        const { id, data } = result.value

        const info = data.providerInfo
        const product = data.product
        const capValues = data.productCapabilityValues

        // Find serviceURL in capabilities
        const urlIdx = product.capabilityKeys.indexOf("serviceURL")
        if (urlIdx < 0 || !capValues[urlIdx]) continue

        // Decode hex-encoded serviceURL
        let serviceURL: string
        try {
          serviceURL = hexToString(capValues[urlIdx] as Hex).replace(
            /\0+$/,
            ""
          )
        } catch {
          continue
        }

        if (!serviceURL.startsWith("http")) continue

        resolved.push({
          id,
          address: info.serviceProvider,
          serviceURL: serviceURL.replace(/\/$/, ""),
          name: info.name,
          description: info.description,
        })
      }

      // Progress output for large batches
      if (providerIds.length > batchSize) {
        console.log(
          `[providers] Resolved ${Math.min(i + batchSize, providerIds.length)}/${providerIds.length}...`
        )
      }
    }

    this.providers = resolved
    console.log(`[providers] ${resolved.length} providers with serviceURLs:`)
    for (const p of resolved) {
      console.log(`  [${p.id}] ${p.name} -> ${p.serviceURL}`)
    }
  }
}
