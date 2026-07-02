import 'dotenv/config';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';

import { cragAgent } from './agents/crag-agent.js';
import { cragWorkflow } from './workflows/crag-workflow.js';

export const mastra = new Mastra({
  storage: new LibSQLStore({ id: 'mastra-storage', url: 'file:./mastra-memory.db' }),
  agents: { cragAgent },
  workflows: { 'crag-workflow': cragWorkflow },
});
