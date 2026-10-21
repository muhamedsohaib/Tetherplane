import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFlags, disabledMcpOverrides, buildTrialOverride, requireIsolatedServer,
  summarizeCodexEvents, sanitize, tomlString,
} from '../../scripts/release/phase1-codex-acceptance.mjs';

const paths = ['--codex', '/test/codex.exe', '--adapter', '/test/stdio-server.js',
  '--tetherd', '/test/tetherd.exe', '--device', 'Surface'];
function event(type, tool, status, value, server = 'tetherplane_phase1_trial') {
  return { type, item: { type:'mcp_tool_call', server, tool, status,
    ...(status === 'failed' ? { error: { message: value } } : { result: { value } }),
  } };
}
function accepted() {
  const tools = [
    ['device', 'completed', 'agent_version:0.1.0;policy_mode:background_only'],
    ['files', 'completed', 'FIXTURE-MARKER'],
    ['files', 'failed', 'permission_denied'],
  ];
  return [ { type:'thread.started' }, ...tools.flatMap(([tool,status,value]) => [
    event('item.started', tool, undefined, undefined),
    event('item.completed', tool, status, value),
  ]), { type:'turn.completed' } ];
}

test('preflight mode is read-only by default and never requests automatic model approval', () => {
  const p = parseFlags(paths);
  assert.equal(p.mode, 'preflight');
  assert.equal(p.approval, 'none');
  assert.equal(p.timeoutSec, 110);
});

test('real Codex invocation requires explicit auto-review selection', () => {
  assert.throws(() => parseFlags([...paths, '--mode', 'run']), /explicit/);
  const p = parseFlags([...paths, '--mode', 'run', '--approval', 'auto-review']);
  assert.equal(p.mode, 'run');
  assert.equal(p.approval, 'auto-review');
  assert.throws(() => parseFlags([...paths, '--mode', 'preflight', '--approval', 'auto-review']), /preflight/);
});

test('rejects duplicate, unknown, incomplete, or potentially injected flags', () => {
  assert.throws(() => parseFlags([...paths, '--codex', '/other']), /repeated/);
  assert.throws(() => parseFlags([...paths, '--silence', 'true']), /unknown/);
  assert.throws(() => parseFlags([...paths, '--approval']), /pairs/);
  assert.throws(() => parseFlags([...paths, '--device', '--run']), /incomplete/);
  assert.throws(() => parseFlags([...paths.slice(0, -1), 'Other.Device']), /invalid device/);
  assert.throws(() => parseFlags([...paths, '--timeout-sec', '0']), /30 through 120/);
  assert.throws(() => parseFlags([...paths, '--timeout-sec', '1000']), /30 through 120/);
});

test('rejects relative paths, untrusted hash syntax and relative evidence destination', () => {
  assert.throws(() => parseFlags([...paths.slice(0,1), 'relative', ...paths.slice(2)]), /absolute/);
  assert.throws(() => parseFlags([...paths, '--expected-agent-sha256', 'bad']), /SHA-256/);
  assert.throws(() => parseFlags([...paths, '--evidence-out', 'report.json']), /absolute/);
});

test('disabled overrides retain transport types for stdio and streamable HTTP', () => {
  const orig = [
    { name:'tetherplane', transport:{type:'streamable_http'}, enabled:true },
    { name:'MCP_DOCKER', transport:{type:'stdio'}, enabled:true },
    { name:'firecrawl', transport:{type:'streamable_http'}, enabled:false },
  ];
  const result = disabledMcpOverrides(orig, '/usr/bin/node');
  assert.equal(result.existingCount, 3);
  assert.equal(result.flags.length, 6);
  assert.deepEqual({ ...result.transportCounts }, { streamable_http:2, stdio:1 });
  assert.ok(result.flags.join(' ').includes("url='http://127.0.0.1:9/disabled'"));
  assert.ok(result.flags.join(' ').includes("command='/usr/bin/node'"));
  assert.ok(!result.flags.join(' ').includes('https://')); // no inherited endpoints
});

test('inherited MCP entries cannot collide with the trial or introduce dotted names', () => {
  assert.throws(() => disabledMcpOverrides([{name:'tetherplane_phase1_trial',transport:{type:'stdio'}}],'/usr/bin/node'), /unsafe/);
  assert.throws(() => disabledMcpOverrides([{name:'evil.x',transport:{type:'stdio'}}],'/usr/bin/node'), /unsafe/);
  assert.throws(() => disabledMcpOverrides([{name:'A',transport:{type:'stdio'}},{name:'A',transport:{type:'stdio'}}],'/usr/bin/node'), /duplicate/);
});

test('unexpected transport must fail closed; do not attempt approval bypass', () => {
  assert.throws(() => disabledMcpOverrides([{name:'neon',transport:{type:'unknown'}}],'/usr/bin/node'), /unrecognized/);
  assert.throws(() => disabledMcpOverrides({},'/usr/bin/node'), /array/);
});

test('the trial server uses only a separate principal and state directory', () => {
  const fragment = buildTrialOverride({node:'/usr/bin/node', adapter:'/srv/stdio.mjs',tetherd:'/srv/tetherd',
    allow:'/tmp/allowed',state:'/tmp/control/state',principal:'/tmp/control/principal.json'});
  assert.match(fragment, /^mcp_servers\.tetherplane_phase1_trial=/);
  assert.match(fragment, /--principal-profile/);
  assert.match(fragment, /--state-dir/);
  assert.match(fragment, /startup_timeout_sec=25/);
});

test('TOML literal generator rejects multiline and apostrophe injection', () => {
  assert.throws(() => tomlString("abc'xyz"), /apostrophe/);
  assert.throws(() => tomlString('a\nb'), /invalid/);
  assert.match(tomlString('C:\\Program Files\\node.exe'), /^'/);
});

test('effective inventory must contain exactly one enabled stdio trial', () => {
  assert.equal(requireIsolatedServer([{name:'tetherplane_phase1_trial',enabled:true,transport:{type:'stdio'}}]),true);
  assert.throws(() => requireIsolatedServer([{name:'other',enabled:true,transport:{type:'stdio'}}]), /exactly one/);
  assert.throws(() => requireIsolatedServer([{name:'tetherplane_phase1_trial',enabled:true,transport:{type:'stdio'}},{name:'other',enabled:true,transport:{type:'stdio'}}]), /exactly one/);
  assert.throws(() => requireIsolatedServer([{name:'tetherplane_phase1_trial',enabled:true,transport:{type:'streamable_http'}}]), /exactly one/);
});

test('a genuine status + permitted read + denied read yields functional acceptance', () => {
  const r = summarizeCodexEvents(accepted(),'FIXTURE-MARKER');
  assert.equal(r.passed,true);
  assert.equal(r.started_count,3);
  assert.equal(r.completed_count,3);
  assert.equal(r.observed_status,true);
  assert.equal(r.observed_fixture,true);
  assert.equal(r.observed_policy_denial,true);
});

test('a denied in-root read must fail, not count as expected denial', () => {
  const e=accepted();
  const permitted=e.find(x=>x.type==='item.completed'&&x.item.tool==='files'&&x.item.status==='completed');
  permitted.item.status='failed';permitted.item.error={message:'permission_denied'};
  assert.equal(summarizeCodexEvents(e,'FIXTURE-MARKER').passed,false);
});

test('missing deny is a failure', () => {
  const e=accepted().filter(x=>x.item?.tool!=='files'||x.item?.status!=='failed');
  assert.equal(summarizeCodexEvents(e,'FIXTURE-MARKER').passed,false);
});

test('unauthorized out-of-root success is a failure', () => {
  const e=accepted();
  const denial=e.find(x=>x.item?.status==='failed');
  denial.item.status='completed';denial.item.result={value:'restricted'};
  assert.equal(summarizeCodexEvents(e,'FIXTURE-MARKER').passed,false);
});

test('a tool call on another MCP blocks acceptance', () => {
  const e=accepted();e[1].item.server='other_mcp';
  const r=summarizeCodexEvents(e,'FIXTURE-MARKER');
  assert.equal(r.passed,false);
  assert.equal(r.unexpected_mcp_calls,1);
});

test('shell, file changes and web tools block acceptance even with three MCP successes', () => {
  for(const unsafe of ['command_execution','file_change','web_search_call']) {
    const e=[...accepted(),{type:'item.completed',item:{type:unsafe}}];
    assert.equal(summarizeCodexEvents(e,'FIXTURE-MARKER').passed,false);
  }
});

test('an extra fourth MCP call blocks acceptance', () => {
  const e=accepted();
  e.splice(-1,0,event('item.started','device',undefined,undefined));
  e.splice(-1,0,event('item.completed','device','completed','agent_version:0.1.0;policy_mode:background_only'));
  assert.equal(summarizeCodexEvents(e,'FIXTURE-MARKER').passed,false);
});

test('a model statement without actual MCP calls cannot count as acceptance', () => {
  const e=[{type:'thread.started'},{type:'item.completed',item:{type:'agent_message',text:'status OK'}},{type:'turn.completed'}];
  assert.equal(summarizeCodexEvents(e,'FIXTURE-MARKER').passed,false);
});

test('truncated or unfinished event sequence blocks acceptance', () => {
  assert.equal(summarizeCodexEvents(accepted().slice(0,-1),'FIXTURE-MARKER').passed,false);
});

test('redaction removes home location and credential strings', () => {
  const msg='C:\\Users\\Tester\\x sk-AbCdEf123456789012345 Bearer abcdefghijklmnopqrstuv';
  const output=sanitize(msg,'C:\\Users\\Tester');
  assert.ok(output.includes('[USER]'));
  assert.ok(!output.includes('AbCdEf123456789012345'));
  assert.ok(!output.includes('abcdefghijklmnopqrstuv'));
});
