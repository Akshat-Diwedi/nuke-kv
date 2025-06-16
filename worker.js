// worker.js
const { parentPort } = require('worker_threads');

// Worker to handle CPU-intensive tasks in parallel
parentPort.on('message', (task) => {
  try {
    let result;
    
    switch (task.type) {
      case 'process_batch':
        result = processBatch(task.commands);
        break;
      case 'json_parse':
        result = JSON.parse(task.data);
        break;
      case 'json_stringify':
        result = JSON.stringify(task.data);
        break;
      case 'compute_hash':
        result = computeHash(task.key);
        break;
      default:
        result = { error: 'Unknown task type' };
    }
    
    parentPort.postMessage(result);
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});

// Process a batch of commands
function processBatch(commands) {
  const results = [];
  
  for (const cmd of commands) {
    let result;
    switch (cmd.operation) {
      // Simple mock implementations for worker processing
      // Actual data operations happen in the main thread
      case 'compute':
        result = heavyComputation(cmd.data);
        break;
      default:
        result = { status: 'ERROR', message: 'Unsupported worker operation' };
    }
    results.push(result);
  }
  
  return results;
}

// Simulate a CPU-intensive task
function heavyComputation(data) {
  let result = 0;
  for (let i = 0; i < 1000000; i++) {
    result += Math.sqrt(i) * Math.sin(i);
  }
  return { result };
}

// Compute a simple hash for sharding
function computeHash(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}