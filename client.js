// client.js

const net = require('net');
const readline = require('readline');
const { runStressTest } = require('./stress');

const client = net.createConnection({ port: 6380 }, () => {
  console.log('🧠 Connected to NukeKV');
});

client.on('data', (data) => {
  console.log(data.toString());
});

client.on('end', () => {
  console.log('🧹 Disconnected');
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
});

rl.prompt();

rl.on('line', (line) => {
  const trimmedLine = line.trim();
  
  if (trimmedLine.toUpperCase() === 'STRESS') {
    console.log('🚀 Starting optimized stress test with 100K operations...');
    console.log('⚠️  This may take a while and put significant load on your system.');
    
    // Close the current client connection to free up resources
    client.end();
    
    // Run the stress test
    runStressTest()
      .then(() => {
        console.log('🔄 Reconnecting regular client...');
        // Reconnect the regular client after the stress test
        setTimeout(() => {
          const newClient = net.createConnection({ port: 6380 }, () => {
            console.log('🧠 Reconnected to NukeKV');
            // Update the client reference
            client.removeAllListeners();
            Object.assign(client, newClient);
            rl.prompt();
          });
          
          newClient.on('data', (data) => {
            console.log(data.toString());
          });
          
          newClient.on('end', () => {
            console.log('🧹 Disconnected');
          });
        }, 1000);
      })
      .catch(err => {
        console.error('❌ Stress test failed:', err);
        rl.prompt();
      });
  } else {
    client.write(trimmedLine + '\n');
    rl.prompt();
  }
});