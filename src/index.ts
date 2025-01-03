#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as cheerio from 'cheerio';

interface DocSection {
  title: string;
  content: string;
  url: string;
}

class SolanaDocsServer {
  private server: Server;
  private baseDocsUrl = 'https://docs.solana.com';
  private apiDocsUrl = 'https://docs.rs/solana-sdk/latest/solana_sdk';

  constructor() {
    this.server = new Server(
      {
        name: 'solana-docs-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_latest_docs',
          description: 'Get latest Solana documentation sections',
          inputSchema: {
            type: 'object',
            properties: {
              section: {
                type: 'string',
                description: 'Documentation section to fetch (e.g., "developing", "running-validator", "economics")',
              },
            },
            required: ['section'],
          },
        },
        {
          name: 'search_docs',
          description: 'Search through Solana documentation',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_api_reference',
          description: 'Get Solana SDK API reference details',
          inputSchema: {
            type: 'object',
            properties: {
              item: {
                type: 'string',
                description: 'API item to look up (e.g., "transaction", "pubkey", "system_instruction")',
              },
            },
            required: ['item'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'get_latest_docs':
          return await this.handleGetLatestDocs(request.params.arguments);
        case 'search_docs':
          return await this.handleSearchDocs(request.params.arguments);
        case 'get_api_reference':
          return await this.handleGetApiReference(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleGetLatestDocs(args: any) {
    if (!args.section || typeof args.section !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid section parameter');
    }

    try {
      const response = await axios.get(`${this.baseDocsUrl}/${args.section}`);
      const $ = cheerio.load(response.data);
      
      const content = $('.markdown-section').text();
      const title = $('h1').first().text();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              title,
              content: content.substring(0, 1000) + '...',  // Truncate for readability
              url: `${this.baseDocsUrl}/${args.section}`,
              timestamp: new Date().toISOString(),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching docs: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleSearchDocs(args: any) {
    if (!args.query || typeof args.query !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid query parameter');
    }

    try {
      // First get the main page to extract sections
      const mainResponse = await axios.get(this.baseDocsUrl);
      const $ = cheerio.load(mainResponse.data);
      
      const searchResults: DocSection[] = [];
      
      // Search through main navigation items
      const navItems = $('.sidebar-nav').find('a');
      const searchPromises = navItems.map(async (_, el) => {
        const href = $(el).attr('href');
        if (href && !href.startsWith('http')) {
          try {
            const pageResponse = await axios.get(`${this.baseDocsUrl}${href}`);
            const page$ = cheerio.load(pageResponse.data);
            const content = page$('.markdown-section').text();
            
            if (content.toLowerCase().includes(args.query.toLowerCase())) {
              searchResults.push({
                title: page$('h1').first().text() || $(el).text(),
                content: content.substring(0, 200) + '...',  // Preview
                url: `${this.baseDocsUrl}${href}`,
              });
            }
          } catch (error) {
            console.error(`Error searching page ${href}:`, error);
          }
        }
      }).get();

      await Promise.all(searchPromises);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query: args.query,
              results: searchResults,
              timestamp: new Date().toISOString(),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching docs: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGetApiReference(args: any) {
    if (!args.item || typeof args.item !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid item parameter');
    }

    try {
      const response = await axios.get(`${this.apiDocsUrl}/${args.item.toLowerCase()}`);
      const $ = cheerio.load(response.data);
      
      // Extract API documentation
      const docContent = $('.docblock').first().text();
      const signature = $('.rust.fn, .rust.struct, .rust.trait').first().text();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              item: args.item,
              signature,
              documentation: docContent,
              url: `${this.apiDocsUrl}/${args.item.toLowerCase()}`,
              timestamp: new Date().toISOString(),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching API reference: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Solana Docs MCP server running on stdio');
  }
}

const server = new SolanaDocsServer();
server.run().catch(console.error);
