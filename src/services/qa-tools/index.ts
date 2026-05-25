import type { ToolDefinition } from './types.js'
import { resolveEntityTool } from './resolve-entity.js'
import { getTalkSummaryTool } from './get-talk-summary.js'
import { searchChunksTool } from './search-chunks.js'
import { synthesizeAcrossTalksTool } from './synthesize-across-talks.js'
import { getOverviewTool } from './get-overview.js'
import { getMetadataTool } from './get-metadata.js'

export const QA_TOOLS: ToolDefinition[] = [
  resolveEntityTool,
  getTalkSummaryTool,
  searchChunksTool,
  synthesizeAcrossTalksTool,
  getOverviewTool,
  getMetadataTool,
]

export type { ToolDefinition, ToolContext, ToolExecutionResult, ToolCall } from './types.js'
