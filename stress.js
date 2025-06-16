// stress.js

const net = require('net');
const cluster = require('cluster');
const os = require('os');

// Configuration
const TOTAL_OPERATIONS = 200000;
const KEY_PREFIX = 'key_';
const MIN_WORDS = 20;

// 200 - 852286 OPS/SEC ✨

const BATCH_SIZE = 200; // Number of commands to send in a single batch
const PIPELINE_MODE = true; // Use pipelining for maximum throughput


const WORKER_COUNT = Math.max(1, os.cpus().length - 1); // Use all available cores except one
// const WORKER_COUNT = os.cpus().length; // Use all available CPU cores


// Pre-generate random values to avoid generating them during the test
const WORD_LIST = [
  'apple', 'banana', 'orange', 'grape', 'kiwi', 'mango', 'pear', 'peach',
  'plum', 'cherry', 'strawberry', 'blueberry', 'raspberry', 'blackberry',
  'watermelon', 'melon', 'pineapple', 'coconut', 'avocado', 'fig', 'date',
  'lemon', 'lime', 'papaya', 'guava', 'pomegranate', 'apricot', 'nectarine',
  'cantaloupe', 'honeydew', 'tangerine', 'clementine', 'cranberry', 'passion',
  'dragonfruit', 'durian', 'lychee', 'persimmon', 'quince', 'kumquat', 'kiwano'
];

// Generate a random string with at least MIN_WORDS words
function generateRandomValue() {
  let result = '';
  const wordCount = MIN_WORDS;
  
  for (let i = 0; i < wordCount; i++) {
    const randomWord = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
    result += randomWord + ' ';
  }
  
  return result.trim();
}

// Pre-generate all values to avoid generating them during the test
function preGenerateValues(count) {
  const values = [];
  for (let i = 0; i < count; i++) {
    values.push(generateRandomValue());
  }
  return values;
}

// Run stress test in a worker process
function runWorkerTest(workerId, operationsPerWorker, preGeneratedValues) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ port: 6380 }, async () => {
      console.log(`Worker ${workerId}: Connected to NukeKV`);
      
      const startTime = process.hrtime.bigint();
      let completedOperations = 0;
      let responseCount = 0;
      let buffer = '';
      
      // Set up data handler to track progress
      client.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep the last incomplete line in the buffer
        
        responseCount += lines.length;
        
        // Check if all operations are completed
        if (responseCount >= operationsPerWorker * 2) { // SET + GET
          const endTime = process.hrtime.bigint();
          const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
          
          client.end();
          resolve({
            workerId,
            duration,
            operationsPerSecond: ((operationsPerWorker * 2) / (duration / 1000))
          });
        }
      });
      
      // Phase 1: SET operations with pipelining
      console.log(`Worker ${workerId}: Performing SET operations...`);
      
      if (PIPELINE_MODE) {
        // Send commands in batches for better throughput
        for (let batchStart = 0; batchStart < operationsPerWorker; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, operationsPerWorker);
          let batchCommands = '';
          
          for (let i = batchStart; i < batchEnd; i++) {
            const key = `${KEY_PREFIX}${workerId}_${i}`;
            const value = preGeneratedValues[i % preGeneratedValues.length];
            batchCommands += `SET ${key} ${value}\n`;
          }
          
          client.write(batchCommands);
          await new Promise(resolve => setTimeout(resolve, 5)); // Small delay between batches
        }
      } else {
        // Traditional mode - wait for response after each command
        for (let i = 0; i < operationsPerWorker; i++) {
          const key = `${KEY_PREFIX}${workerId}_${i}`;
          const value = preGeneratedValues[i % preGeneratedValues.length];
          client.write(`SET ${key} ${value}\n`);
          await new Promise(resolve => setTimeout(resolve, 1)); // Small delay between commands
        }
      }
      
      // Phase 2: GET operations with pipelining
      console.log(`Worker ${workerId}: Performing GET operations...`);
      
      if (PIPELINE_MODE) {
        // Send commands in batches for better throughput
        for (let batchStart = 0; batchStart < operationsPerWorker; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, operationsPerWorker);
          let batchCommands = '';
          
          for (let i = batchStart; i < batchEnd; i++) {
            const key = `${KEY_PREFIX}${workerId}_${i}`;
            batchCommands += `GET ${key}\n`;
          }
          
          client.write(batchCommands);
          await new Promise(resolve => setTimeout(resolve, 5)); // Small delay between batches
        }
      } else {
        // Traditional mode - wait for response after each command
        for (let i = 0; i < operationsPerWorker; i++) {
          const key = `${KEY_PREFIX}${workerId}_${i}`;
          client.write(`GET ${key}\n`);
          await new Promise(resolve => setTimeout(resolve, 1)); // Small delay between commands
        }
      }
    });
    
    client.on('error', (err) => {
      console.error(`Worker ${workerId}: Error during stress test:`, err.message);
      reject(err);
    });
    
    client.on('end', () => {
      console.log(`Worker ${workerId}: Disconnected from NukeKV`);
    });
  });
}

// Run stress test with multiple workers
async function runMultiWorkerTest() {
  if (cluster.isPrimary) {
    console.log(`🧠 Starting stress test with ${WORKER_COUNT} workers`);
    console.log(`🔥 Each worker will perform ${Math.floor(TOTAL_OPERATIONS / WORKER_COUNT)} operations`);
    console.log(`📊 Total operations: ${TOTAL_OPERATIONS} SET + ${TOTAL_OPERATIONS} GET = ${TOTAL_OPERATIONS * 2} operations`);
    
    const startTime = process.hrtime.bigint();
    const results = [];
    
    // Fork workers
    for (let i = 0; i < WORKER_COUNT; i++) {
      const worker = cluster.fork();
      
      worker.on('message', (result) => {
        results.push(result);
        
        // Check if all workers have completed
        if (results.length === WORKER_COUNT) {
          const endTime = process.hrtime.bigint();
          const totalDuration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
          
          // Calculate aggregate statistics
          const totalOps = TOTAL_OPERATIONS * 2; // SET + GET
          const opsPerSecond = totalOps / (totalDuration / 1000);
          
          console.log('\n✅ Stress test completed!');
          console.log(`⏱️  Total time: ${totalDuration.toFixed(2)} ms`);
          console.log(`⚡ Average operations per second: ${opsPerSecond.toFixed(2)} ops/sec`);
          console.log('\n📊 Worker statistics:');
          
          results.forEach(result => {
            console.log(`   Worker ${result.workerId}: ${result.operationsPerSecond.toFixed(2)} ops/sec (${result.duration.toFixed(2)} ms)`);
          });
          
          // Exit the process
          process.exit(0);
        }
      });
    }
  } else {
    // Worker process
    const workerId = cluster.worker.id;
    const operationsPerWorker = Math.floor(TOTAL_OPERATIONS / WORKER_COUNT);
    
    // Pre-generate values
    console.log(`Worker ${workerId}: Pre-generating ${operationsPerWorker} values...`);
    const preGeneratedValues = preGenerateValues(1000); // Generate 1000 values and reuse them
    
    try {
      const result = await runWorkerTest(workerId, operationsPerWorker, preGeneratedValues);
      process.send(result);
    } catch (err) {
      console.error(`Worker ${workerId}: Error:`, err);
      process.exit(1);
    }
  }
}

// Run stress test with a single connection using the PIPELINE command
async function runPipelineTest() {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ port: 6380 }, async () => {
      console.log('🧠 Connected to NukeKV - Starting Pipeline Stress Test');
      
      const startTime = process.hrtime.bigint();
      let buffer = '';
      
      client.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep the last incomplete line in the buffer
        
        // Check for completion message
        for (const line of lines) {
          if (line.includes('Operations per second:')) {
            const opsPerSecond = parseInt(line.split(':')[1].trim());
            const endTime = process.hrtime.bigint();
            const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
            
            console.log('\n✅ Pipeline stress test completed!');
            console.log(`⏱️  Total time: ${duration.toFixed(2)} ms`);
            console.log(`⚡ Server reported: ${opsPerSecond} ops/sec`);
            
            client.end();
            resolve({ opsPerSecond, duration });
            break;
          }
        }
      });
      
      // Use the server's PIPELINE command to run the stress test
      console.log(`📥 Running PIPELINE command with ${TOTAL_OPERATIONS} operations...`);
      client.write(`PIPELINE ${TOTAL_OPERATIONS}\n`);
    });
    
    client.on('error', (err) => {
      console.error('❌ Error during pipeline stress test:', err.message);
      reject(err);
    });
    
    client.on('end', () => {
      console.log('🧹 Disconnected from NukeKV');
    });
  });
}

// Main stress test function that decides which mode to use
async function runStressTest() {
  console.log('🚀 Starting optimized stress test');
  console.log(`⚙️  Configuration:`);
  console.log(`   - Total operations: ${TOTAL_OPERATIONS} SET + ${TOTAL_OPERATIONS} GET`);
  console.log(`   - Batch size: ${BATCH_SIZE}`);
  console.log(`   - Pipeline mode: ${PIPELINE_MODE ? 'Enabled' : 'Disabled'}`);
  console.log(`   - Worker count: ${WORKER_COUNT}`);
  
  try {
    let testFunctionCalled = false; // Flag to ensure test function is called only once
        const client = net.createConnection({ port: 6379 }, async () => {
      let buffer = '';
      let pipelineSupported = false;
      
      client.on('data', (data) => {
        buffer += data.toString();
        
        if (buffer.includes('unknown command')) {
          // Server doesn't support PIPELINE command, use multi-worker mode
          if (!testFunctionCalled) {
            testFunctionCalled = true;
            client.end();
            runMultiWorkerTest();
          }
        } else if (buffer.includes('Processed')) {
          // Server supports PIPELINE command, use it for better performance
          if (!testFunctionCalled) {
            testFunctionCalled = true;
            client.end();
            runPipelineTest();
          }
        }
      });
      
      // Try the PIPELINE command with a small count
      client.write('PIPELINE 10\n');
    });
    
    client.on('error', (err) => {
      console.error('❌ Error checking server capabilities:', err.message);
      // Fall back to multi-worker mode
      if (!testFunctionCalled) {
        testFunctionCalled = true;
        // Ensure client is ended before starting new test to prevent multiple connections/tests
        if (client && !client.destroyed) {
            client.end();
        }
        runMultiWorkerTest();
      }
    });
  } catch (err) {
    console.error('❌ Error during stress test setup:', err.message);
    throw err;
  }
}

// Export the function to be used by client.js
module.exports = { runStressTest };

// If this script is run directly
if (require.main === module) {
  runStressTest().catch(console.error);
}