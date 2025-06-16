// worker.js
const { parentPort } = require('worker_threads');

// Performance monitoring
const metrics = {
  tasksProcessed: 0,
  totalProcessingTime: 0,
  errors: 0,
  lastReset: Date.now()
};

// Task type handlers
const taskHandlers = {
  process_batch: (commands) => {
    const results = [];
    const startTime = process.hrtime.bigint();
    
    for (const cmd of commands) {
      try {
        let result;
        switch (cmd.operation) {
          case 'compute':
            result = heavyComputation(cmd.data);
            break;
          case 'json_parse':
            result = JSON.parse(cmd.data);
            break;
          case 'json_stringify':
            result = JSON.stringify(cmd.data);
            break;
          default:
            result = { status: 'ERROR', message: 'Unsupported worker operation' };
        }
        results.push(result);
      } catch (error) {
        metrics.errors++;
        results.push({ status: 'ERROR', message: error.message });
      }
    }
    
    const endTime = process.hrtime.bigint();
    const processingTime = Number(endTime - startTime) / 1000;
    metrics.totalProcessingTime += processingTime;
    metrics.tasksProcessed += commands.length;
    
    return { results, processingTime };
  },
  
  json_parse: (data) => {
    const startTime = process.hrtime.bigint();
    const result = JSON.parse(data);
    const endTime = process.hrtime.bigint();
    const processingTime = Number(endTime - startTime) / 1000;
    
    metrics.totalProcessingTime += processingTime;
    metrics.tasksProcessed++;
    
    return { result, processingTime };
  },
  
  json_stringify: (data) => {
    const startTime = process.hrtime.bigint();
    const result = JSON.stringify(data);
    const endTime = process.hrtime.bigint();
    const processingTime = Number(endTime - startTime) / 1000;
    
    metrics.totalProcessingTime += processingTime;
    metrics.tasksProcessed++;
    
    return { result, processingTime };
  },
  
  compute_hash: (key) => {
    const startTime = process.hrtime.bigint();
    const result = computeHash(key);
    const endTime = process.hrtime.bigint();
    const processingTime = Number(endTime - startTime) / 1000;
    
    metrics.totalProcessingTime += processingTime;
    metrics.tasksProcessed++;
    
    return { result, processingTime };
  }
};

// Worker message handler
parentPort.on('message', (task) => {
  try {
    const handler = taskHandlers[task.type];
    if (!handler) {
      throw new Error(`Unknown task type: ${task.type}`);
    }
    
    const result = handler(task.data);
    parentPort.postMessage(result);
  } catch (error) {
    metrics.errors++;
    parentPort.postMessage({ error: error.message });
  }
});

// Simulate a CPU-intensive task with better performance
function heavyComputation(data) {
  const startTime = process.hrtime.bigint();
  let result = 0;
  
  // Use SIMD-like operations where possible
  const chunkSize = 1000;
  const iterations = Math.floor(1000000 / chunkSize);
  
  for (let i = 0; i < iterations; i++) {
    const chunk = new Float64Array(chunkSize);
    for (let j = 0; j < chunkSize; j++) {
      const idx = i * chunkSize + j;
      chunk[j] = Math.sqrt(idx) * Math.sin(idx);
    }
    result += chunk.reduce((a, b) => a + b, 0);
  }
  
  const endTime = process.hrtime.bigint();
  const processingTime = Number(endTime - startTime) / 1000;
  
  return { result, processingTime };
}

// Compute hash function optimized for performance
function computeHash(key) {
  let hash = 0;
  const str = String(key);
  
  // Use a fast hashing algorithm
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  return hash;
}

// Reset metrics periodically
setInterval(() => {
  const now = Date.now();
  const elapsed = now - metrics.lastReset;
  
  if (elapsed >= 60000) { // Reset every minute
    metrics.tasksProcessed = 0;
    metrics.totalProcessingTime = 0;
    metrics.errors = 0;
    metrics.lastReset = now;
  }
}, 60000);