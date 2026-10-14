import { resolve } from 'node:path';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';
import { simulatedAdapter, simulatedReviewer } from './adapters/simulated.js';

const command = process.argv[2] ?? 'status';
if (!['demo', 'status'].includes(command)) {
  console.error('Usage: node src/cli.js <demo|status> [state-directory]');
  process.exitCode = 1;
} else {
  const store = new Store(resolve(process.argv[3] ?? '.nightshift'));
  try {
    store.acquire();
    if (command === 'demo') {
      const supervisor = new Supervisor(store, simulatedAdapter, simulatedReviewer);
      if (!supervisor.snapshot().tasks.length) {
        supervisor.add({ id: 'brief', title: 'Prepare project brief', acceptance: 'Requirements and constraints recorded.' });
        supervisor.add({ id: 'prototype', title: 'Build a first prototype', acceptance: 'Prototype passes defined checks.', dependencies: ['brief'] });
      }
      await supervisor.run();
    }
    console.log(JSON.stringify(store.read(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { store.release(); }
}
