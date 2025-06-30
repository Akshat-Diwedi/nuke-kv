const net = require("net");
const readline = require("readline");
const { performance } = require("perf_hooks");

// --- ANSI color codes for a better terminal experience ---
const colors = {
  reset: "\x1b[0m",
  lightGreen: "\x1b[92m", // For successful server responses
  lightRed: "\x1b[91m",   // For connection errors
  cyan: "\x1b[36m",       // For client info messages
  yellow: "\x1b[93m",     // For latency information
};

// --- Configuration ---
const config = {
  host: "localhost", // Use 'localhost' or the server's IP address
  port: 8080,
};

// Create a TCP socket
const client = new net.Socket();
let isConnected = false;
let responseBuffer = Buffer.alloc(0); // Buffer to assemble incoming data chunks
let awaitingResponse = false;
let startTime; // To store the start time for latency measurement

// Create an interface for reading lines from the console
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function setPrompt() {
    const prompt_char = isConnected ? '>' : '!';
    rl.setPrompt(`${colors.cyan}${prompt_char}${colors.reset} `);
    rl.prompt();
}

/**
 * Sends a command to the NukeKV server using the nuke-wire protocol.
 * The protocol frames messages with an 8-byte length prefix.
 * @param {string} command The command string to send.
 */
function sendCommand(command) {
  if (!command) {
    setPrompt();
    return;
  }
  if (!isConnected) {
    console.log(`${colors.lightRed}Not connected to the server. Type 'connect' to try again.${colors.reset}`);
    setPrompt();
    return;
  }
  if (awaitingResponse) {
    console.log(`${colors.yellow}Waiting for server response, please wait...${colors.reset}`);
    return;
  }

  const payload = Buffer.from(command, "utf-8");
  // Frame the message: 8-byte length header (Big Endian) + payload
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(payload.length));
  
  const message = Buffer.concat([header, payload]);
  
  awaitingResponse = true;
  startTime = performance.now();
  client.write(message);
}

// --- Socket Event Handlers ---

client.on("connect", () => {
  isConnected = true;
  console.log(`${colors.cyan}Successfully connected to NukeKV server at ${config.host}:${config.port}${colors.reset}`);
  console.log('Type a command and press Enter. Type "exit" or press Ctrl+C to quit.');
  setPrompt();
});

client.on("data", (chunk) => {
  responseBuffer = Buffer.concat([responseBuffer, chunk]);

  while (true) {
    if (responseBuffer.length < 8) {
      break; 
    }

    const bodyLength = Number(responseBuffer.readBigUInt64BE(0));
    const totalMsgLength = 8 + bodyLength;

    if (responseBuffer.length < totalMsgLength) {
      break; 
    }

    const responseBody = responseBuffer.subarray(8, totalMsgLength).toString("utf-8");
    const endTime = performance.now();
    const latency = (endTime - startTime).toFixed(2);
    
    const coloredResponse = `${colors.lightGreen}${responseBody}${colors.reset}`;
    const coloredLatency = `${colors.yellow} (latency: ${latency}ms)${colors.reset}`;
    
    console.log(coloredResponse + coloredLatency);

    responseBuffer = responseBuffer.subarray(totalMsgLength);
    awaitingResponse = false;
    setPrompt();
  }
});

client.on("close", () => {
  isConnected = false;
  awaitingResponse = false;
  console.log(`\n${colors.lightRed}Connection to server closed.${colors.reset}`);
  setPrompt();
});

client.on("error", (err) => {
  isConnected = false;
  awaitingResponse = false;
  console.error(
    `${colors.lightRed}❌ Connection Error: ${err.message}${colors.reset}`
  );
  setPrompt();
});

// --- Main Application Logic ---

console.log(`${colors.cyan}NukeKV Interactive Client (nuke-wire protocol)${colors.reset}`);
console.log(`Attempting to connect to ${config.host}:${config.port}...`);
client.connect(config.port, config.host);

rl.on("line", (line) => {
  const command = line.trim().toLowerCase();
  switch (command) {
    case "exit":
      rl.close();
      break;
    case "connect":
        if (!isConnected) client.connect(config.port, config.host);
        else console.log(`${colors.cyan}Already connected.${colors.reset}`)
        break;
    default:
      sendCommand(line.trim());
      break;
  }
});

rl.on("close", () => {
  console.log(`\n${colors.cyan}Shutting down client. Goodbye!${colors.reset}`);
  client.end();
  process.exit(0);
});