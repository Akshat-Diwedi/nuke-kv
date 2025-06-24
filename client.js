const http = require("http");
const readline = require("readline");
const { performance } = require("perf_hooks");

// --- ANSI color codes for a better terminal experience ---
const colors = {
  reset: "\x1b[0m",
  lightGreen: "\x1b[92m", // For successful server responses
  lightRed: "\x1b[91m",   // For connection errors
  cyan: "\x1b[36m",      // For client info messages
  yellow: "\x1b[93m",     // <-- For latency information
};

// --- Configuration ---
const options = {
  hostname: "localhost", // Use 'localhost' or the server's IP address
  port: 8080,
  path: "/",
  method: "POST",
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
  },
};

// --- Create an interface for reading lines from the console ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${colors.cyan}>${colors.reset} `,
});

/**
 * Sends a command to the NukeKV server and measures latency.
 * @param {string} command The command string to send.
 */
function sendCommand(command) {
  if (!command) {
    rl.prompt();
    return;
  }

  options.headers["Content-Length"] = Buffer.byteLength(command);

  let startTime; // <-- To store the start time

  const req = http.request(options, (res) => {
    let responseBody = "";
    res.setEncoding("utf8");

    res.on("data", (chunk) => {
      responseBody += chunk;
    });

    res.on("end", () => {
      // THE FIX IS HERE: Calculate latency and display it
      const endTime = performance.now();
      const latency = (endTime - startTime).toFixed(2); // Calculate and format to 2 decimal places

      const coloredResponse = `${colors.lightGreen}${responseBody}${colors.reset}`;
      const coloredLatency = `${colors.yellow} (latency: ${latency}ms)${colors.reset}`;

      console.log(coloredResponse + coloredLatency);
      rl.prompt();
    });
  });

  req.on("error", (error) => {
    const errorMessage = `❌ Connection Error: ${error.message}`;
    const helpMessage = "Is the server running? Please check and try again.";
    console.error(
      `${colors.lightRed}${errorMessage}\n${helpMessage}${colors.reset}`,
    );
    rl.prompt();
  });

  // Record the start time right before sending the request
  startTime = performance.now();
  req.write(command);
  req.end();
}

// --- Main Application Logic ---
console.log(`${colors.cyan}NukeKV Client${colors.reset}`);
console.log(
  `Connecting to http://${options.hostname}:${options.port}`,
);
console.log(
  'Type a command and press Enter. Type "exit" or press Ctrl+C to quit.',
);

rl.prompt();

rl.on("line", (line) => {
  const command = line.trim();
  if (command.toLowerCase() === "exit") {
    rl.close();
  } else {
    sendCommand(command);
  }
});

rl.on("close", () => {
  console.log(`\n${colors.cyan}Shutting down client. Goodbye!${colors.reset}`);
  process.exit(0);
});