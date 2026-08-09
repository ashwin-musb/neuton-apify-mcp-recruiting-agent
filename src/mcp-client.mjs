import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ACTORS = [
  'neuton/linkedin-jobs-search-scraper',
  'neuton/linkedin-job-details-scraper',
];

export async function connectToApify() {
  if (!process.env.APIFY_TOKEN) {
    throw new Error('Set APIFY_TOKEN before running this example.');
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      'node_modules/@apify/actors-mcp-server/dist/stdio.js',
      '--tools',
      ACTORS.join(','),
    ],
    env: {
      ...process.env,
      APIFY_TOKEN: process.env.APIFY_TOKEN,
    },
  });

  const client = new Client({
    name: 'neuton-recruiting-research-example',
    version: '1.0.0',
  });

  await client.connect(transport);
  return { client, transport };
}

export function findActorTool(tools, actorSlug) {
  const normalized = actorSlug.replaceAll('-', '_');
  const matches = tools.filter((tool) =>
    tool.name.includes(actorSlug) || tool.name.includes(normalized),
  );

  if (matches.length !== 1) {
    throw new Error(
      `Expected one MCP tool for ${actorSlug}, found ${matches.length}: ${matches
        .map((tool) => tool.name)
        .join(', ')}`,
    );
  }

  return matches[0];
}
