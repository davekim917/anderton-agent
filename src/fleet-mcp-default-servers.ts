import type { McpServerConfig } from './container-config.js';

/** Seed only: once the file exists it wins. Add tools with `ncl groups config add-mcp-server --fleet`, not here. */
export const DEFAULT_FLEET_MCP_SERVERS: Record<string, McpServerConfig> = {};
