// utils.js
const fs = require('fs').promises; // Use fs.promises for async operations
const path = require('path');

const DB_FILE_PATH = path.join(__dirname, 'nukekv.db');

// Function to save data to a file
async function saveToFile(data) {
  try {
    await fs.writeFile(DB_FILE_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving data to file:', err);
    return false;
  }
}

// Function to load data from a file
async function loadFromFile() {
  try {
    // Check if file exists asynchronously
    await fs.access(DB_FILE_PATH, fs.constants.F_OK);
    const fileData = await fs.readFile(DB_FILE_PATH, 'utf-8');
    return JSON.parse(fileData);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null; // File does not exist
    }
    console.error('Error loading data from file:', err);
    return null;
  }
}

// Function to parse value (handle numbers, strings, JSON)
async function parseValue(str) {
  if (!isNaN(str) && !isNaN(parseFloat(str))) {
    return parseFloat(str);
  }
  try {
    // Attempt to parse as JSON using worker thread for large payloads
    if (typeof workerPool !== 'undefined') { // Check if workerPool is available (main thread)
      const result = await workerPool.runTask({ type: 'json_parse', data: str });
      if (!result.error) return result;
    }
    // Fallback to direct JSON.parse if worker not available or worker failed
    return JSON.parse(str);
  } catch (e) {
    // Not a valid JSON, treat as a string
    // Remove quotes if it's a quoted string
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
      return str.slice(1, -1);
    }
    return str;
  }
}

// Helper for performance timing (can be expanded)
function startTimer() {
  return process.hrtime.bigint();
}

function endTimer(startTime) {
  const endTime = process.hrtime.bigint();
  return Number(endTime - startTime) / 1000; // Microseconds
}

module.exports = {
  saveToFile,
  loadFromFile,
  parseValue,
  startTimer,
  endTimer
};