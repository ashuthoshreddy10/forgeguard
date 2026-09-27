// TEST FIXTURE ONLY — a stand-in for the bobshell entry point used by unit tests.
// It is never used by the application at runtime. It records the argv it received
// and emits Bob Shell 2.0.5-style stream-json according to FAKE_BOB_BEHAVIOR.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_BOB_ARGV_FILE) {
  fs.writeFileSync(process.env.FAKE_BOB_ARGV_FILE, JSON.stringify(args));
}

if (args[0] === '--version') {
  console.log('9.9.9-fake');
  process.exit(0);
}
if (args[0] === 'run' && args.includes('--help')) {
  console.log(process.env.FAKE_BOB_HELP ??
    'Usage: bob run [options] [prompt...]\n  -f, --format <format> pretty, json or stream-json\n  -w, --workspace <path>\n  --mode <mode>\n  --max-turns <number>\n  --disable-tool-groups <groups>');
  process.exit(0);
}

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const behavior = process.env.FAKE_BOB_BEHAVIOR ?? 'success';

switch (behavior) {
  case 'success':
    out({ type: 'message', role: 'user', content: 'prompt echo' });
    out({ type: 'message', role: 'assistant', isReasoning: true, content: 'thinking...' });
    out({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: {} });
    out({ type: 'message', role: 'assistant', isReasoning: false, content: 'Analysis done.\n--- FORGEGUARD:JSON ---\n{"ok":' });
    out({ type: 'message', role: 'assistant', isReasoning: false, content: 'true}\n--- END ---' });
    out({ type: 'result', status: 'success', stats: { task_id: 'bob-task-123', duration_ms: 5 } });
    process.exit(0);
    break;
  case 'error':
    out({ type: 'error', severity: 'error', message: 'The task reached the maximum of 30 turns.' });
    process.stderr.write('Error: task limit\n');
    process.exit(1);
    break;
  case 'error-exit0':
    out({ type: 'error', severity: 'error', message: 'Budget exceeded' });
    process.exit(0);
    break;
  case 'nonzero':
    process.stderr.write('Fatal error: boom\n');
    process.exit(3);
    break;
  case 'noresult':
    out({ type: 'message', role: 'assistant', content: 'partial' });
    process.exit(0);
    break;
  case 'leak': {
    const k = process.env.BOBSHELL_API_KEY ?? '';
    out({ type: 'message', role: 'assistant', content: `key is ${k}` });
    process.stderr.write(`auth header ${k}\n`);
    out({ type: 'result', status: 'success', stats: { task_id: 'bob-task-leak' } });
    process.exit(0);
    break;
  }
  case 'hang':
    setTimeout(() => process.exit(0), 60_000);
    break;
  default:
    process.exit(2);
}
