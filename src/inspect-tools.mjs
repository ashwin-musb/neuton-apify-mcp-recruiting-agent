import { connectToApify } from './mcp-client.mjs';

const { client, transport } = await connectToApify();

try {
  const { tools } = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));
} finally {
  await client.close();
  await transport.close();
}
