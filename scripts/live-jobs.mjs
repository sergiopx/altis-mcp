import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const SERVER = '/Users/sp/code/altis-mcp/dist/index.js';
const seeds = ['plate','barbell','wendler','1rm','one rep max','deadlift','squat','bench press','powerlifting','strength log','lifting log','gym log','weight plate','bar load','warmup sets'];
const mk = async () => { const c = new Client({ name: 'live', version: '0' }); const t = new StdioClientTransport({ command: 'node', args: [SERVER] }); await c.connect(t); return { c, t }; };
const call = (c, name, args = {}) => c.callTool({ name, arguments: args }).then(r => JSON.parse(r.content[0].text));

const a = await mk();
const t0 = Date.now();
const started = await call(a.c, 'screen', { seeds, appId: '6768525538', async: true, rescreenAfterDays: 0 });
console.log(`screen returned in ${Date.now() - t0} ms:`, JSON.stringify(started));
const pidA = a.t.pid;
await a.c.close(); // client 1 disconnects; its server process should keep running
console.log('client 1 closed; server pid', pidA);

const b = await mk();
let st;
for (let i = 0; i < 24; i++) {
  await new Promise(r => setTimeout(r, 5000));
  st = await call(b.c, 'screen_job_status', { jobId: started.jobId });
  const p = st.progress;
  console.log(`t+${(i+1)*5}s owner=${st.owner} status=${st.status} phase=${p.phase} seeds=${p.seedsExpanded}/${p.seedsTotal} queries=${p.queriesDone}/${p.queriesTotal} cand=${p.candidatesFound} checks=${p.checksDone}/${p.checksTotal} skipped=${p.candidatesSkipped} rl=${p.rateLimits} backoff=${p.backoffSeconds} eta=${p.etaSeconds}s`);
  if (p.checksDone > 0 && p.seedsExpanded < p.seedsTotal) { console.log('ACCEPTANCE: checksDone > 0 while seedsExpanded < seedsTotal'); break; }
  if (st.status !== 'running') break;
}
console.log('recent:', JSON.stringify(st.progress.recent.slice(0, 3)));
console.log('rate (this process, not the job\'s):', JSON.stringify(await call(b.c, 'rate_status')).slice(0, 200));
const res = await call(b.c, 'screen_results', { appId: '6768525538', since: new Date(t0).toISOString(), limit: 3 });
console.log('screen_results pending:', JSON.stringify(res.pending), 'total since start:', res.total);
console.log('cancel:', JSON.stringify(await call(b.c, 'screen_job_cancel', { jobId: started.jobId })));
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 2000));
  st = await call(b.c, 'screen_job_status', { jobId: started.jobId });
  if (st.status !== 'running') break;
}
console.log('final status:', st.status, 'owner:', st.owner, 'checksDone:', st.progress.checksDone, 'error:', st.progress.error);
let alive = true; try { process.kill(pidA, 0); } catch { alive = false; }
await new Promise(r => setTimeout(r, 3000));
try { process.kill(pidA, 0); alive = true; } catch { alive = false; }
console.log('server A still alive after cancel+3s:', alive);
console.log('jobs:', JSON.stringify((await call(b.c, 'screen_jobs', { limit: 2 })).map(j => [j.jobId, j.status, j.owner])));
await b.c.close();
