// utils.js
const fs = require('fs').promises; // Use fs.promises for async operations
const path = require('path');

// Debug mode flag - when true, timing information will be displayed
const DEBUG = true;

// Constants
const DB_FILE_PATH = path.join(__dirname, 'nukekv.db');
const MAX_VALUE_SIZE = 512 * 1024 * 1024; // 512MB value size limit

// Function to save data to a file
async function saveToFile(data) {
  try {
    console.log(`Attempting to save data to: ${DB_FILE_PATH}`);

    // Create a deep copy of the data to avoid modifying the in-memory object
    const dataToSave = JSON.parse(JSON.stringify(data));

    // This map will store the single-line JSON strings for our values
    const replacements = new Map();

    // 1. Prepare for custom serialization
    // Iterate over the store and replace objects with unique placeholders
    if (dataToSave.store) {
      for (const key in dataToSave.store) {
        if (Object.prototype.hasOwnProperty.call(dataToSave.store, key)) {
          const value = dataToSave.store[key];
          // Check if the value is an object (and not null) to be formatted
          if (typeof value === 'object' && value !== null) {
            // Create a single-line JSON string from the object
            const singleLineJson = JSON.stringify(value);
            
            // Create a unique placeholder. Using a timestamp and random number for safety.
            const placeholder = `__JSON_PLACEHOLDER_${key}_${Date.now()}_${Math.random()}__`;

            // Store the placeholder and its corresponding single-line JSON
            replacements.set(placeholder, singleLineJson);
            
            // Replace the actual object with the placeholder string in our temporary data
            dataToSave.store[key] = placeholder;
          }
        }
      }
    }

    // 2. Pretty-print the structure with placeholders
    let prettyString = JSON.stringify(dataToSave, null, 2);

    // 3. Replace the placeholders with their actual single-line JSON values
    for (const [placeholder, singleLineJson] of replacements.entries()) {
      // We need to replace the placeholder *including* the quotes that JSON.stringify added
      prettyString = prettyString.replace(`"${placeholder}"`, singleLineJson);
    }

    await fs.writeFile(DB_FILE_PATH, prettyString);
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

    // Handle empty file case
    if (!fileData || fileData.trim() === '') {
      // Create and save default empty structure
      const defaultData = {
        "store": {},
        "ttl": {}
      };
      // Use the original saveToFile which now handles formatting correctly
      await saveToFile(defaultData);
      return defaultData;
    }

    return JSON.parse(fileData);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File does not exist, create default structure
      const defaultData = {
        "store": {},
        "ttl": {}
      };
      await saveToFile(defaultData);
      return defaultData;
    }
    console.error('Error loading data from file:', err);

    // If JSON parsing failed, create default structure
    if (err instanceof SyntaxError) {
      const defaultData = {
        "store": {},
        "ttl": {}
      };
      await saveToFile(defaultData);
      return defaultData;
    }

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
      const result = await workerPool.runTask({
        type: 'json_parse',
        data: str
      });
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
  endTimer,
  DEBUG,
  MAX_VALUE_SIZE
};