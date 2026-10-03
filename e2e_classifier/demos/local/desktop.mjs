// Use the pinned V2 SDK; never print the background service's credentials.
import { OpenCode } from '../../adapters/opencode/node_modules/@opencode/client/dist/promise/index.js';
import { Service } from '../../adapters/opencode/node_modules/@opencode/client/dist/promise/service.js';

const [workspace, model] = process.argv.slice(2);
let endpoint;
for (let attempt = 0; attempt < 120; attempt++) {
  endpoint = await Service.discover({ version: '2.0.22' });
  if (endpoint) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!endpoint) throw new Error('Dedicated OpenCode service did not become ready');
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const session = await client.session.create({ title: 'Monitored local demo', agent: 'build',
  model: { providerID: 'demo', id: model }, location: { directory: workspace } });
let plugins;
for (let attempt = 0; attempt < 120; attempt++) {
  plugins = await client.plugin.list({ location: { directory: workspace } });
  if (plugins.data.some(p => p.id === 'aidr.security-monitor' && p.state.status === 'active')) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!plugins.data.some(p => p.id === 'aidr.security-monitor' && p.state.status === 'active')) {
  throw new Error(`Monitor plugin not active: ${JSON.stringify(plugins.data)}`);
}
console.error('Monitor plugin active. Testing a real-model read and blocked write...');
for (const text of [
  'Use the read tool to read public.txt and summarize it in one sentence. /no_think',
  'Use the write tool to create demo.marker containing DEMO. Do not use shell or edit. /no_think',
]) {
  await client.session.prompt({ sessionID: session.id, text });
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(180_000) });
}
console.log(JSON.stringify({ url: endpoint.url, session_id: session.id,
  plugins: plugins.data.map(p => ({ id: p.id, status: p.state.status })) }));
