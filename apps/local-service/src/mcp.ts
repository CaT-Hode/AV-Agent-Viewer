import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentMcpServer } from './mcp-server';
await createAgentMcpServer().connect(new StdioServerTransport());
