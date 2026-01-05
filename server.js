require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const database = require('./db');
const { traits } = require('./traits');
const { initialReactions, contextPrompts } = require('./reaction');
const GCloudService = require('./gcloudService');
const Trait = require('./models/Trait');
const genAiService = require('./services/genAiService');

// Concurrency Controller for parallel processing with limit
class ConcurrencyController {
  constructor(limit = 5) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    while (this.running >= this.limit) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const resolve = this.queue.shift();
      if (resolve) resolve();
    }
  }
}

// Get concurrency limit from environment or default to 5
const CONCURRENCY_LIMIT = parseInt(process.env.GENAI_CONCURRENCY_LIMIT || '5', 10);
const genAiConcurrency = new ConcurrencyController(CONCURRENCY_LIMIT);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const gcloudService = new GCloudService();

// Track if server is shutting down (for Cloud Run graceful shutdown)
let isShuttingDown = false;

// WebSocket server with ping/pong to keep connections alive
const wss = new WebSocket.Server({
  server,
  clientTracking: true,
  perMessageDeflate: false
});

// Store connected clients
const clients = new Set();

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('✅ New WebSocket client connected');
  clients.add(ws);

  // Mark connection as alive
  ws.isAlive = true;
  ws.lastPong = Date.now();

  // Set connection timeout (30 seconds)
  const connectionTimeout = setTimeout(() => {
    if (ws.isAlive === false) {
      console.log('⚠️ Connection timeout, terminating');
      ws.terminate();
    }
  }, 30000);

  // Send welcome message (with error handling)
  try {
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'WebSocket connection established',
      timestamp: new Date().toISOString()
    }), (err) => {
      if (err) {
        console.error('Error sending welcome message:', err);
        clients.delete(ws);
      }
    });
  } catch (error) {
    console.error('Error in welcome message:', error);
    clients.delete(ws);
    return;
  }

  // Handle pong response (client is alive)
  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastPong = Date.now();
  });

  // Handle client disconnect
  ws.on('close', (code, reason) => {
    clearTimeout(connectionTimeout);
    // Only log if not a normal closure
    if (code !== 1000 && code !== 1001) {
      console.log(`❌ WebSocket client disconnected (code: ${code}, reason: ${reason?.toString() || 'none'})`);
    }
    clients.delete(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    clearTimeout(connectionTimeout);
    console.error('WebSocket error:', error.message || error);
    clients.delete(ws);
    try {
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.terminate();
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  // Handle incoming messages (if needed)
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      // Handle client messages if needed
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }), (err) => {
          if (err) {
            console.error('Error sending pong:', err);
          }
        });
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });
});

// Ping all clients every 30 seconds to keep connections alive
const pingInterval = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    // Check if connection hasn't responded to pong in 60 seconds (more lenient)
    if (ws.lastPong && (now - ws.lastPong) > 60000) {
      console.log('⚠️ Terminating dead WebSocket connection (no pong for 60s)');
      try {
        ws.terminate();
      } catch (err) {
        // Ignore
      }
      clients.delete(ws);
      return;
    }

    // Mark as not alive, wait for pong
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      console.error('Error pinging WebSocket client:', error);
      clients.delete(ws);
      try {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.terminate();
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });
}, 30000);

// Graceful shutdown handler for Cloud Run (SIGTERM) and local (SIGINT)
async function gracefulShutdown(signal) {
  console.log(`\n⚠️ ${signal} signal received. Starting graceful shutdown...`);
  isShuttingDown = true;

  // Stop accepting new requests (give 10 seconds to finish existing)
  const shutdownTimeout = setTimeout(() => {
    console.log('⏱️ Shutdown timeout reached, forcing exit...');
    process.exit(1);
  }, 10000);

  try {
    // Clear ping interval
    clearInterval(pingInterval);
    
    // Flush any remaining broadcasts
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
    }
    if (broadcastQueue.length > 0) {
      console.log(`📤 Flushing ${broadcastQueue.length} queued broadcasts...`);
      flushBroadcastQueue();
    }

    // Close WebSocket connections gracefully
    console.log(`🔌 Closing ${clients.size} WebSocket connection(s)...`);
    clients.forEach(client => {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'server_shutdown',
            message: 'Server is shutting down',
            timestamp: new Date().toISOString()
          }), () => {
            client.close(1000, 'Server shutdown');
          });
        } else {
          client.terminate();
        }
      } catch (err) {
        client.terminate();
      }
    });

    // Close WebSocket server
    wss.close(() => {
      console.log('✅ WebSocket server closed');
    });

    // Close HTTP server
    server.close(() => {
      console.log('✅ HTTP server closed');
    });

    // Close database connection
    await database.disconnect();
    console.log('✅ Database connection closed');

    clearTimeout(shutdownTimeout);
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

// Handle Cloud Run SIGTERM (graceful shutdown request)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle SIGINT (Ctrl+C for local development)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejection, just log it
});

// Broadcast queue for batching updates to prevent WebSocket overload
const broadcastQueue = [];
let broadcastTimer = null;
const BROADCAST_BATCH_INTERVAL = 500; // 500ms batching window
const BROADCAST_MAX_BATCH_SIZE = 50; // Max updates per batch

// Helper function to broadcast to all connected clients (with batching)
function broadcastUpdate(data) {
  // Add to queue
  broadcastQueue.push(data);

  // Start timer if not already running
  if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      flushBroadcastQueue();
    }, BROADCAST_BATCH_INTERVAL);
  }

  // Flush immediately if queue is too large
  if (broadcastQueue.length >= BROADCAST_MAX_BATCH_SIZE) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
    flushBroadcastQueue();
  }
}

// Flush broadcast queue and send batched updates
function flushBroadcastQueue() {
  if (broadcastQueue.length === 0) {
    broadcastTimer = null;
    return;
  }

  // Take all queued updates
  const updates = broadcastQueue.splice(0, BROADCAST_MAX_BATCH_SIZE);
  broadcastTimer = null;

  // If single update, send as-is; otherwise batch
  const payload = updates.length === 1
    ? updates[0]
    : {
        type: 'batch_update',
        count: updates.length,
        updates: updates,
        timestamp: new Date().toISOString()
      };

  const message = JSON.stringify(payload);
  let sentCount = 0;
  let errorCount = 0;
  const deadClients = [];

  clients.forEach((client) => {
    // Check connection health before sending
    if (client.readyState === WebSocket.OPEN) {
      try {
        // Check if buffer is not too full (backpressure check)
        if (client.bufferedAmount < 1024 * 1024) { // 1MB threshold
          client.send(message, (err) => {
            if (err) {
              console.error('WebSocket send error:', err);
              deadClients.push(client);
            }
          });
          sentCount++;
        } else {
          console.warn('⚠️ Client buffer full, skipping send');
          deadClients.push(client);
        }
      } catch (error) {
        console.error('Error sending WebSocket message:', error);
        errorCount++;
        deadClients.push(client);
      }
    } else {
      // Remove closed connections
      deadClients.push(client);
    }
  });

  // Clean up dead clients
  deadClients.forEach(client => {
    try {
      clients.delete(client);
      if (client.readyState !== WebSocket.CLOSED && client.readyState !== WebSocket.CLOSING) {
        client.terminate();
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  if (sentCount > 0) {
    console.log(`📤 Broadcasted ${updates.length} update(s) to ${sentCount} client(s)`);
  }
  if (errorCount > 0 || deadClients.length > 0) {
    console.warn(`⚠️ Failed/removed ${errorCount + deadClients.length} client(s)`);
  }

  // If more items in queue, schedule next flush
  if (broadcastQueue.length > 0) {
    broadcastTimer = setTimeout(() => {
      flushBroadcastQueue();
    }, BROADCAST_BATCH_INTERVAL);
  }
}

// Enable CORS for all origins
app.use(cors());

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function
function generateObjectId() {
  const timestamp = Math.floor(Date.now() / 1000).toString(16);
  const randomBytes = Math.random().toString(16).substring(2, 14);
  const counter = (Math.floor(Math.random() * 16777215)).toString(16).padStart(6, '0');
  return timestamp + randomBytes + counter;
}

// Basic route
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Express.js Server!',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Example API route
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from the API!' });
});

// Get all traits
app.get('/api/traits', (req, res) => {
  const simplifiedTraits = traits.map(trait => ({
    title: trait.title,
    traitType: trait.traitType,
    contextPromptEnabled: trait.contextPromptEnabled,
    initialReactionEnabled: trait.initialReactionEnabled
  }));

  res.json({
    success: true,
    count: simplifiedTraits.length,
    data: simplifiedTraits
  });
});

// Get traits with context prompt enabled
app.get('/api/traits/context-prompt', (req, res) => {
  const contextPromptTraits = traits.filter(trait => trait.contextPromptEnabled);
  res.json({
    success: true,
    count: contextPromptTraits.length,
    data: contextPromptTraits
  });
});

// Get traits with initial reaction enabled
app.get('/api/traits/initial-reaction', (req, res) => {
  const initialReactionTraits = traits.filter(trait => trait.initialReactionEnabled);
  res.json({
    success: true,
    count: initialReactionTraits.length,
    data: initialReactionTraits
  });
});

// Process traits and queue tasks to Google Cloud
app.post('/api/traits/process', async (req, res) => {
  try {
    const { csv_data, version, project_input, concept_input } = req.body;

    // Validate required fields
    if (!csv_data || !Array.isArray(csv_data) || csv_data.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'csv_data is required and must be a non-empty array'
      });
    }

    if (!version) {
      return res.status(400).json({
        success: false,
        error: 'version is required (context or basic)'
      });
    }

    // Validate version enum
    const versionLower = version.toLowerCase();
    if (!['context', 'basic'].includes(versionLower)) {
      return res.status(400).json({
        success: false,
        error: 'version must be either "context" or "basic"'
      });
    }

    // If version is context, project_input and concept_input are required
    if (versionLower === 'context') {
      if (!project_input) {
        return res.status(400).json({
          success: false,
          error: 'project_input is required when version is context'
        });
      }
      if (!concept_input) {
        return res.status(400).json({
          success: false,
          error: 'concept_input is required when version is context'
        });
      }
    }

    const projectId = "691f0de3cde91b17bbb84746";



    // Map csv_data and save to database
    const savedDocuments = [];

    for (const item of csv_data) {
      // Prepare data structure for saving
      const traitData = {
        project_input: project_input || '',
        concept_input: concept_input || '',
        version: versionLower,
        hunch_id: item.hunch_id,
        concept_name: item.concept_name
      };

      // Save initial_reaction if exists
      if (item.initial_reaction && item.initial_reaction.trim()) {
        traitData.initial_reaction = {
          text: item.initial_reaction.trim(),
          traits: [],
          genAiRecords: [],
          reviewTags: []
          // type: 'INITIAL_REACTION' is default in schema
        };
        traitData.context_prompt = {
          text: item.context_prompt.trim(),
          traits: [],
          genAiRecords: [],
          reviewTags: []
          // type: 'CONTEXT_PROMPT' is default in schema
        };

        const savedDoc = await Trait.create(traitData);
        savedDocuments.push({
          mongoId: savedDoc._id.toString(),
          type: 'INITIAL_REACTION'
        });

        // Broadcast document created
        broadcastUpdate({
          type: 'document_created',
          documentId: savedDoc._id.toString(),
          document: {
            _id: savedDoc._id.toString(),
            project_input: savedDoc.project_input,
            concept_input: savedDoc.concept_input,
            version: savedDoc.version,
            initial_reaction: savedDoc.initial_reaction,
            context_prompt: savedDoc.context_prompt,
            hunch_id: savedDoc.hunch_id,
            concept_name: savedDoc.concept_name
          },
          timestamp: new Date().toISOString()
        });
      }


    }


    // Fetch saved documents from database
    const allSavedDocs = await Trait.find({
      processed: false
    }).lean();

    // Separate initial_reaction and context_prompt data
    const initialReactionData = allSavedDocs
      .filter(doc => doc.initial_reaction && doc.initial_reaction.text)
      .map(doc => ({
        ID: doc._id.toString(),
        comment: gcloudService.cleanText(doc.initial_reaction.text)
      }));

    const contextPromptData = allSavedDocs
      .filter(doc => doc.context_prompt && doc.context_prompt.text)
      .map(doc => ({
        ID: doc._id.toString(), // MongoDB _id as ID
        comment: gcloudService.cleanText(doc.context_prompt.text) // text as comment
      }));

    console.log(`✅ Fetched ${allSavedDocs.length} documents from DB`);

    // Get enabled traits
    const initialReactionTraits = traits.filter(trait => trait.initialReactionEnabled);
    const contextPromptTraits = traits.filter(trait => trait.contextPromptEnabled);

    // First: Queue initial_reaction data
    if (initialReactionData.length > 0 && initialReactionTraits.length > 0) {
      for (const model of initialReactionTraits) {
        try {
          if (model.gcsFileName && projectId) {
            await gcloudService.queueTraitTasks(
              initialReactionData,
              projectId,
              model.gcsFileName,
              'INITIAL_REACTION'
            );
            console.log(`✅ Queued INITIAL_REACTION task for ${model.title}`);
          }
        } catch (error) {
          console.error(`Error queuing INITIAL_REACTION task for ${model.title}:`, error);
        }
      }
    }

    // // Then: Queue context_prompt data
    if (contextPromptData.length > 0 && contextPromptTraits.length > 0) {
      for (const model of contextPromptTraits) {
        try {
          if (model.gcsFileName && projectId) {
            await gcloudService.queueTraitTasks(
              contextPromptData,
              projectId,
              model.gcsFileName,
              'CONTEXT_PROMPT'
            );
            console.log(`✅ Queued CONTEXT_PROMPT task for ${model.title}`);

            // Broadcast task queued
          }
        } catch (error) {
          console.error(`Error queuing CONTEXT_PROMPT task for ${model.title}:`, error);
        }
      }
    }

    // Use already fetched documents for response
    res.json({
      success: true,
      message: 'Data saved and tasks queued successfully',
      data: allSavedDocs.map(doc => ({
        _id: doc._id.toString(),
        project_input: doc.project_input,
        concept_input: doc.concept_input,
        version: doc.version,
        initial_reaction: doc.initial_reaction,
        context_prompt: doc.context_prompt,
        hunch_id: doc.hunch_id,
        concept_name: doc.concept_name,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
      })),
      count: allSavedDocs.length,
      savedDocuments: savedDocuments.map(doc => ({
        mongoId: doc.mongoId,
        type: doc.type
      })),
      projectId,
      conceptInput: concept_input,
      version: versionLower,
      queuedTasks: {
        initialReaction: initialReactionData.length > 0 ? initialReactionTraits.length : 0,
        contextPrompt: contextPromptData.length > 0 ? contextPromptTraits.length : 0
      }
    });
  } catch (error) {
    console.error('Error processing traits:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Trait prediction callback endpoint
app.post('/trait-prediction', async (req, res) => {
  try {
    const { data, model_filename, type } = req.body;

    if (!data || !Array.isArray(data)) {
      return res.status(400).json({ success: false, error: 'Data must be an array' });
    }
    if (!model_filename || !type) {
      return res.status(400).json({ success: false, error: 'model_filename and type required' });
    }

    // 🔥 IMPORTANT: respond immediately
    res.status(200).json({
      success: true,
      message: 'Trait prediction received and queued',
      items: data.length
    });

    // 🧠 background processing (non-blocking)
    processTraitPrediction(req.body)
      .catch(err => console.error('❌ Background processing failed:', err));

  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get reactions data
app.get('/api/reactions/initial', (req, res) => {
  res.json({
    success: true,
    count: initialReactions.filter(r => r).length,
    data: initialReactions.filter(r => r)
  });
});

app.get('/api/reactions/context', (req, res) => {
  res.json({
    success: true,
    count: contextPrompts.length,
    data: contextPrompts
  });
});

// ==================== Trait Database Fetch APIs ====================
// Add feedback to a specific trait's genAiRecords entry
// Body: { documentId, traitName, feedback, type: 'INITIAL_REACTION' | 'CONTEXT_PROMPT' }
app.post('/api/traits/feedback', async (req, res) => {
  try {
    const { documentId, traitName, feedback, type } = req.body;

    if (!documentId || !traitName || !feedback || !type) {
      return res.status(400).json({
        success: false,
        error: 'documentId, traitName, feedback, and type are required'
      });
    }

    const targetType = type === 'INITIAL_REACTION' ? 'initial_reaction'
      : type === 'CONTEXT_PROMPT' ? 'context_prompt'
        : null;

    if (!targetType) {
      return res.status(400).json({ success: false, error: 'type must be INITIAL_REACTION or CONTEXT_PROMPT' });
    }

    const doc = await Trait.findById(documentId);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    const target = doc[targetType];
    if (!target || !Array.isArray(target.genAiRecords)) {
      return res.status(404).json({ success: false, error: `No genAiRecords found for type ${type}` });
    }

    // Find the most recent matching record by traitTitle
    const idx = [...target.genAiRecords].reverse().findIndex(
      r => r.traitTitle === traitName
    );
    if (idx === -1) {
      return res.status(404).json({ success: false, error: `genAiRecord for trait ${traitName} not found` });
    }

    // Map back to original index
    const recordIndex = target.genAiRecords.length - 1 - idx;
    const existing = target.genAiRecords[recordIndex] || {};

    // Ensure required fields exist to satisfy schema validation
    target.genAiRecords[recordIndex] = {
      ...existing,
      llmScore: existing.llmScore ?? 0,
      finalScore: existing.finalScore ?? (existing.genAiSays?.score ?? 0),
      action: existing.action ?? 'No change',
      traitTitle: existing.traitTitle ?? traitName,
      genAiSays: existing.genAiSays ?? {},
      feedback
    };

    await doc.save();

    return res.json({
      success: true,
      message: 'Feedback added to genAiRecord',
      documentId,
      type,
      traitName,
      updatedRecord: target.genAiRecords[recordIndex]
    });
  } catch (error) {
    console.error('Error adding feedback:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Store manual feedback based on type
// Body: { traitName, feedback, documentId, type }
app.post('/api/traits/store-feedback', async (req, res) => {
  try {
    const { feedbackArray } = req.body;

    // Support both array format and single item format (backward compatibility)
    let items = [];
    if (feedbackArray && Array.isArray(feedbackArray)) {
      items = feedbackArray;
    } else if (req.body.traitName && req.body.documentId) {
      // Single item format (backward compatibility)
      items = [req.body];
    } else {
      return res.status(400).json({
        success: false,
        error: 'feedbackArray (array) or single feedback item (traitName, feedback, documentId, type) is required'
      });
    }

    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one feedback item is required'
      });
    }

    // Get documentId from first item
    const firstItem = items[0];
    const documentId = firstItem.documentId;

    if (!documentId) {
      return res.status(400).json({
        success: false,
        error: 'documentId is required in feedback items'
      });
    }

    // Find document once
    const doc = await Trait.findById(documentId);
    if (!doc) {
      return res.status(404).json({
        success: false,
        error: `Document not found for ID: ${documentId}`
      });
    }

    // Process all items and group by type
    const feedbackByType = {
      INITIAL_REACTION: [],
      CONTEXT_PROMPT: []
    };

    for (const item of items) {
      const { traitName, feedback, type, shouldExist } = item;

      if (!traitName || !feedback || !type) {
        console.warn('Skipping invalid item:', item);
        continue;
      }

      if (type !== 'INITIAL_REACTION' && type !== 'CONTEXT_PROMPT') {
        console.warn('Skipping item with invalid type:', item);
        continue;
      }

      feedbackByType[type].push({
        trait: traitName,
        text: feedback,
        shouldExist: shouldExist !== undefined ? shouldExist : true
      });
    }

    // Add feedback to appropriate target objects
    let addedCount = 0;

    if (feedbackByType.INITIAL_REACTION.length > 0) {
      if (!doc.initial_reaction) {
        doc.initial_reaction = { feedback: [] };
      }
      if (!doc.initial_reaction.feedback) {
        doc.initial_reaction.feedback = [];
      }
      doc.initial_reaction.feedback.push(...feedbackByType.INITIAL_REACTION);
      addedCount += feedbackByType.INITIAL_REACTION.length;
    }

    if (feedbackByType.CONTEXT_PROMPT.length > 0) {
      if (!doc.context_prompt) {
        doc.context_prompt = { feedback: [] };
      }
      if (!doc.context_prompt.feedback) {
        doc.context_prompt.feedback = [];
      }
      doc.context_prompt.feedback.push(...feedbackByType.CONTEXT_PROMPT);
      addedCount += feedbackByType.CONTEXT_PROMPT.length;
    }

    // Save once
    await doc.save();

    res.json({
      success: true,
      message: 'Feedback stored successfully',
      added: addedCount,
      total: items.length,
      data: {
        initial_reaction: doc.initial_reaction?.feedback || [],
        context_prompt: doc.context_prompt?.feedback || []
      }
    });

  } catch (error) {
    console.error('Error storing feedback:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Get all trait documents from database
app.get('/api/traits/db', async (req, res) => {
  try {
    const traits = await Trait.find()
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: traits.length,
      data: traits
    });
  } catch (error) {
    console.error('Error fetching traits from database:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get trait by ID
app.get('/api/traits/db/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const trait = await Trait.findById(id).lean();

    if (!trait) {
      return res.status(404).json({
        success: false,
        error: 'Trait not found'
      });
    }

    res.json({
      success: true,
      data: trait
    });
  } catch (error) {
    console.error('Error fetching trait by ID:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get traits by type
app.get('/api/traits/db/type/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const query = { type: type.toUpperCase() };

    const traits = await Trait.find(query)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: traits.length,
      data: traits
    });
  } catch (error) {
    console.error('Error fetching traits by type:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get traits containing specific trait name
app.get('/api/traits/db/trait/:traitName', async (req, res) => {
  try {
    const { traitName } = req.params;
    const query = { traits: { $in: [traitName] } };

    const traits = await Trait.find(query)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      count: traits.length,
      data: traits
    });
  } catch (error) {
    console.error('Error fetching traits by trait name:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get traits needing review
app.get('/api/traits/db/review', async (req, res) => {
  try {
    const query = { reviewTags: { $exists: true, $ne: [] } };

    const traits = await Trait.find(query)
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      success: true,
      count: traits.length,
      data: traits
    });
  } catch (error) {
    console.error('Error fetching traits needing review:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get statistics/summary
app.get('/api/traits/db/stats', async (req, res) => {
  try {
    const totalTraits = await Trait.countDocuments();
    const initialReactionCount = await Trait.countDocuments({ type: 'INITIAL_REACTION' });
    const contextPromptCount = await Trait.countDocuments({ type: 'CONTEXT_PROMPT' });
    const reviewNeededCount = await Trait.countDocuments({ reviewTags: { $exists: true, $ne: [] } });

    // Get unique trait names
    const traitNames = await Trait.distinct('traits');
    const traitCounts = {};

    for (const traitName of traitNames) {
      if (traitName) {
        traitCounts[traitName] = await Trait.countDocuments({ traits: { $in: [traitName] } });
      }
    }

    res.json({
      success: true,
      stats: {
        totalDocuments: totalTraits,
        byType: {
          initialReaction: initialReactionCount,
          contextPrompt: contextPromptCount
        },
        reviewNeeded: reviewNeededCount,
        traitDistribution: traitCounts
      }
    });
  } catch (error) {
    console.error('Error fetching trait statistics:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete all trait documents from database
app.delete('/api/traits/db', async (req, res) => {
  try {
    const result = await Trait.deleteMany({});

    console.log(`🗑️  Deleted ${result.deletedCount} trait document(s) from database`);

    res.json({
      success: true,
      message: 'All traits deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error deleting traits from database:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server with database connection
async function startServer() {
  try {
    // Connect to MongoDB
    await database.connect();

    // Start HTTP and WebSocket server
    server.listen(PORT, () => {
      console.log(`Server is running on ${PORT}`);
      console.log(`WebSocket server is running on ws://localhost:${PORT}`);
      console.log(`Database status: ${database.getStatus()}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the application
startServer();
// Process single item in batch (parallel processing helper)
async function processSingleItem(item, type, traitTitle, traitDefinition, traitExamples) {
  try {
    const { ID, commentPrediction } = item;
    if (!ID) {
      console.warn('⚠️ Item missing ID, skipping');
      return { success: false, ID: null, reason: 'Missing ID' };
    }

    const traitDoc = await Trait.findById(ID);
    if (!traitDoc) {
      console.warn(`⚠️ Document not found: ${ID}`);
      return { success: false, ID, reason: 'Document not found' };
    }

    let targetObject;
    let text;

    if (type === 'INITIAL_REACTION') {
      targetObject = traitDoc.initial_reaction;
    } else if (type === 'CONTEXT_PROMPT') {
      targetObject = traitDoc.context_prompt;
    } else {
      return { success: false, ID, reason: 'Invalid type' };
    }

    if (!targetObject?.text) {
      return { success: false, ID, reason: 'No text found' };
    }
    text = targetObject.text;

    // version logic
    let versionToPass = 'basic';
    let projectInput = '';
    let conceptInput = '';

    if (traitDoc.version === 'context') {
      versionToPass = 'context';
      projectInput = traitDoc.project_input || '';
      conceptInput = traitDoc.concept_input || '';
    }

    console.log(`🚀 GenAI start | ID=${ID} | Trait=${traitTitle}`);

    // ✅ Use ConcurrencyController for parallel processing with limit
    const genAiResult = await genAiConcurrency.run(async () => {
      return genAiService.classify(
        text,
        traitTitle,
        traitDefinition,
        traitExamples,
        versionToPass,
        projectInput,
        conceptInput
      );
    });

    if (!genAiResult?.success) {
      console.error(`❌ GenAI failed for ${ID}:`, genAiResult?.error);
      return { success: false, ID, reason: 'GenAI API failed', error: genAiResult?.error };
    }

    const genAiResponse = genAiResult.data;
    const llmScore = commentPrediction;
    const genAiScore = genAiResponse.present ? 1 : 0;

    const { action, finalScore } = genAiService.determineAction(llmScore, genAiResponse);
    const needsReview = genAiService.requiresReview(genAiResponse, llmScore);

    // init arrays
    targetObject.genAiRecords ||= [];
    targetObject.traits ||= [];
    targetObject.reviewTags ||= [];

    const hasTrait = targetObject.traits.includes(traitTitle);

    // record
    const genAiRecord = {
      llmScore,
      genAiSays: {
        present: genAiResponse.present,
        confidence: genAiResponse.confidence,
        rationale: genAiResponse.rationale,
        score: genAiResponse.score
      },
      finalScore,
      action,
      traitTitle,
      timestamp: new Date()
    };

    targetObject.genAiRecords.push(genAiRecord);

    if (finalScore === 1 && !hasTrait) {
      targetObject.traits.push(traitTitle);
    } else if (finalScore === 0 && hasTrait) {
      targetObject.traits = targetObject.traits.filter(t => t !== traitTitle);
    }

    if (needsReview && !targetObject.reviewTags.includes(traitTitle)) {
      targetObject.reviewTags.push(traitTitle);
    }
      traitDoc.processed = true;

    const saved = await traitDoc.save();

    // ✅ Batched WebSocket broadcast
    broadcastUpdate({
      type: finalScore === 1 ? 'trait_added' : 'trait_updated',
      documentId: ID,
      document: saved,
      traitTitle,
      traitType: type,
      llmScore,
      genAiScore,
      finalScore,
      action,
      needsReview,
      timestamp: new Date().toISOString()
    });

    console.log(`✅ DONE | ID=${ID} | Trait=${traitTitle} | Final=${finalScore}`);
    return { success: true, ID, finalScore, action };

  } catch (err) {
    console.error(`❌ Item processing failed (${item?.ID}):`, err.message || err);
    return { success: false, ID: item?.ID, reason: 'Exception', error: err.message };
  }
}

// Main batch processing function with parallel execution
async function processTraitPrediction(body) {
  const startTime = Date.now();
  const { data, model_filename, project_id, type } = body;

  console.log(`📥 Processing batch: ${data?.length || 0} items | Model: ${model_filename} | Type: ${type}`);

  const matchedTrait = traits.find(t => t.gcsFileName === model_filename);
  if (!matchedTrait) {
    console.error(`❌ Trait not found for model: ${model_filename}`);
    return;
  }

  const {
    title: traitTitle,
    trait_definition: traitDefinition = '',
    trait_examples: traitExamples = ''
  } = matchedTrait;

  // Broadcast batch processing start
  broadcastUpdate({
    type: 'batch_processing_started',
    traitTitle,
    traitType: type,
    itemCount: data.length,
    model: model_filename,
    timestamp: new Date().toISOString()
  });

  // ✅ Process all items in parallel with Promise.allSettled
  const results = await Promise.allSettled(
    data.map(item => processSingleItem(item, type, traitTitle, traitDefinition, traitExamples))
  );

  // Calculate statistics
  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
  const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.success)).length;
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`✅ Batch processing complete: ${succeeded} succeeded, ${failed} failed in ${duration}s`);

  // Broadcast batch processing complete
  broadcastUpdate({
    type: 'batch_processing_completed',
    traitTitle,
    traitType: type,
    itemCount: data.length,
    succeeded,
    failed,
    duration: `${duration}s`,
    timestamp: new Date().toISOString()
  });

  // Log failed items for debugging
  if (failed > 0) {
    const failedItems = results
      .filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.success))
      .map(r => {
        if (r.status === 'rejected') {
          return { reason: 'Promise rejected', error: r.reason?.message || r.reason };
        } else {
          return r.value;
        }
      });
    console.error(`❌ Failed items (${failed}):`, JSON.stringify(failedItems, null, 2));
  }
}
