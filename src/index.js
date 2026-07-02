import 'dotenv/config';
import { mastra } from './mastra/index.js';

const DEMO_QUERY =
  process.env.QUERY ?? 'What is retrieval-augmented generation and how does it work?';

async function main() {
  const required = ['AI_GATEWAY_API_KEY', 'UPSTASH_VECTOR_REST_URL', 'TAVILY_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌  Missing environment variables: ${missing.join(', ')}`);
    console.error('    Copy .env.example → .env and fill in your keys.\n');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║         CRAG — Corrective RAG System         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\nQuery: "${DEMO_QUERY}"\n`);

  // Mastra v1: createRun() is async; step progress via run.stream()
  const workflow = mastra.getWorkflow('crag-workflow');
  const run = await workflow.createRun();

  const stream = run.stream({ inputData: { query: DEMO_QUERY } });

  for await (const chunk of stream.fullStream) {
    if (chunk?.type === 'workflow-step-start')  console.log(`  ▶ [${chunk.payload?.stepName ?? chunk.payload?.id}] running…`);
    if (chunk?.type === 'workflow-step-result') console.log(`  ✓ [${chunk.payload?.stepName ?? chunk.payload?.id}] done`);
  }

  const result = await stream.result;

  if (result.status === 'success') {
    const out = result.steps?.['generate-answer']?.output;

    console.log('\n══════════════════════════════════════════════');
    console.log(`Confidence: ${out?.confidence}`);
    if (out?.sourcesUsed?.length > 0) {
      console.log(`Sources: ${out.sourcesUsed.join(', ')}`);
    }
    console.log('\nAnswer:');
    console.log(out?.answer);
    console.log('══════════════════════════════════════════════\n');
  } else {
    console.error('\n❌  Workflow did not complete successfully.');
    console.error(result.error ?? JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
