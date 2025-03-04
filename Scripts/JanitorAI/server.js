const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const util = require('util');

const app = express();
const port = process.env.PORT || 3000;

// Directory for storing logs
const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure logs directory exists
async function ensureLogsDirectory() {
  try {
    await fs.access(LOGS_DIR);
    console.log(`Logs directory exists at: ${LOGS_DIR}`);
  } catch (error) {
    console.log(`Creating logs directory at: ${LOGS_DIR}`);
    await fs.mkdir(LOGS_DIR, { recursive: true });
  }
}

// Configure your custom API keys here
const VALID_API_KEYS = new Set([
  process.env.API_KEY || 'custom-key'
]);

// Keep track of character names we've seen
const loggedCharacters = new Set();

// Middleware to check API key
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers.authorization?.replace('Bearer ', '');

  if (!apiKey || !VALID_API_KEYS.has(apiKey)) {
    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error'
      }
    });
  }
  next();
};

// Function to extract character name from messages
function extractCharacterName(messages) {
  // Look through all messages
  for (const message of messages) {
    if (message.content) {
      // First, remove system tags to avoid matching them
      const contentWithoutSystem = message.content.replace(/<system>.*?<\/system>/gs, '');
      
      // Try to find character tags like <Scarlett>
      const characterTagMatch = contentWithoutSystem.match(/<([A-Za-z][^>\s]+)[\s>]/);
      if (characterTagMatch && characterTagMatch[1]) {
        // Exclude common non-character tags
        const name = characterTagMatch[1];
        if (!['system', 'scenario', 'roleplay_guidlines', '/'].includes(name.toLowerCase())) {
          return name;
        }
      }
      
      // Look for Name: pattern as a fallback
      const nameColon = contentWithoutSystem.match(/Name:\s*([^,\n]+)/i);
      if (nameColon && nameColon[1]) {
        return nameColon[1].trim();
      }
    }
  }
  
  // Default if no name found
  return "unknown";
}

// Process message content to extract and format content between tags
function formatMessageContent(messages) {
  let formattedContent = '';
  
  for (const message of messages) {
    if (!message.content) continue;
    
    // Process based on role
    if (message.role === 'system') {
      formattedContent += `### SYSTEM MESSAGE ###\n\n`;
      
      // Process content to extract tagged sections
      const content = message.content;
      
      // Find all XML-like tags and their content
      const tagPattern = /<([^>]+)>([\s\S]*?)<\/\1>/g;
      let match;
      let tagFound = false;
      
      while ((match = tagPattern.exec(content)) !== null) {
        tagFound = true;
        const tagName = match[1].trim();
        let tagContent = match[2];
        
        // Convert escaped newlines to actual newlines
        tagContent = tagContent.replace(/\\n/g, '\n');
        
        formattedContent += `<${tagName}>\n${tagContent}\n</${tagName}>\n\n`;
      }
      
      // If no tags found, output the raw content with newlines converted
      if (!tagFound) {
        formattedContent += content.replace(/\\n/g, '\n') + '\n\n';
      }
    } 
    else if (message.role === 'assistant') {
      // For assistant messages, wrap in firstmessage tags
      let content = message.content.replace(/\\n/g, '\n');
      formattedContent += `### ASSISTANT MESSAGE ###\n\n<firstmessage>\n${content}\n</firstmessage>\n\n`;
    }
    else if (message.role === 'user') {
      // For user messages, include as is with proper newlines
      let content = message.content.replace(/\\n/g, '\n');
      formattedContent += `### USER MESSAGE ###\n\n${content}\n\n`;
    }
    
    formattedContent += `${'='.repeat(40)}\n\n`;
  }
  
  return formattedContent;
}

async function logRequest(messages, characterName = "unknown") {
  try {
    // Format timestamp
    const timestamp = new Date().toISOString();
    
    // Process and format message content
    const formattedContent = formatMessageContent(messages);
    
    // Create a readable log entry
    const logEntry = `==== Request at ${timestamp} ====\n\n${formattedContent}\n\n`;
    
    // Create a sanitized version of the character name for the filename
    const safeCharName = characterName.toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_');
    
    // Create filename based on character name (in logs directory)
    const filename = path.join(LOGS_DIR, `request_${safeCharName}.log`);
    
    // Check if we've seen this character before
    const isNewCharacter = !loggedCharacters.has(safeCharName);
    
    // Add to our set of logged characters
    loggedCharacters.add(safeCharName);
    
    // Check if file exists
    let fileExists = false;
    try {
      await fs.access(filename);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    
    // Create header for new file
    let fileContent = '';
    if (isNewCharacter || !fileExists) {
      fileContent = `===== LOG FILE FOR CHARACTER: ${characterName} =====\nCreated: ${timestamp}\n\n${logEntry}`;
    } else {
      fileContent = logEntry;
    }
    
    // Write the content (append or create new)
    if (fileExists) {
      await fs.appendFile(filename, fileContent);
    } else {
      await fs.writeFile(filename, fileContent);
      console.log(`Created new log file for character: ${characterName}`);
    }
    
    // Also save the raw JSON for debugging purposes
    const rawFilename = path.join(LOGS_DIR, `request_${safeCharName}_raw.json`);
    await fs.writeFile(rawFilename, JSON.stringify(messages, null, 2));
    
    return { filename, isNewCharacter };
  } catch (error) {
    console.error('Failed to log request:', error);
    return { filename: path.join(LOGS_DIR, 'error-log.log'), isNewCharacter: false };
  }
}

app.use(bodyParser.json());
app.use(cors());

// Mock models endpoint
app.get('/v1/models', apiKeyAuth, (req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: 'mock-model-1',
      object: 'model',
      created: Date.now(),
      owned_by: 'custom-owner'
    }]
  });
});

// Mock chat completion endpoint
app.post('/v1/chat/completions', apiKeyAuth, async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: {
        message: 'Messages array is required',
        type: 'invalid_request_error'
      }
    });
  }

  // Extract character name from messages
  const characterName = extractCharacterName(messages);

  // Generate mock response
  const mockResponse = {
    id: 'mock-' + Math.random().toString(36).substr(2, 9),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model-1',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'This is a mock response from the custom OpenAI-compatible server'
      },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  // Log request with proper formatting using util.inspect
  console.log(util.inspect(req.body, { depth: null, colors: true, maxArrayLength: null }));
  
  // Log to file with character name and formatted content
  const { filename, isNewCharacter } = await logRequest(req.body.messages, characterName);
  
  // Enhanced console message
  if (isNewCharacter) {
    console.log(`New character detected: ${characterName} - Logs saved to '${filename}'`);
  } else {
    console.log(`Logs for ${characterName} appended to '${filename}'`);
  }
  
  res.json(mockResponse);
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'server_error'
    }
  });
});

// Ensure logs directory exists before starting the server
(async () => {
  try {
    await ensureLogsDirectory();
    
    app.listen(port, () => {
      console.log(`Mock OpenAI server running on port ${port}`);
      console.log(`Valid API keys: ${Array.from(VALID_API_KEYS).join(', ')}`);
      console.log(`Log files will be stored in: ${LOGS_DIR}`);
    });
  } catch (error) {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  }
})();
