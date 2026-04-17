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

// Request Queue for handling GenAI API calls sequentially

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const gcloudService = new GCloudService();

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

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'WebSocket connection established',
    timestamp: new Date().toISOString()
  }));

  // Handle pong response (client is alive)
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Handle client disconnect
  ws.on('close', (code, reason) => {
    console.log(`❌ WebSocket client disconnected (code: ${code}, reason: ${reason || 'none'})`);
    clients.delete(ws);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });

  // Handle incoming messages (if needed)
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      // Handle client messages if needed
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });
});

// Ping all clients every 30 seconds to keep connections alive
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('⚠️ WebSocket connection unresponsive');
      // return ws.terminate();
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch (error) {
      console.error('Error pinging WebSocket client:', error);
      clients.delete(ws);
    }
  });
}, 30000);

// Clean up interval on server shutdown
process.on('SIGINT', () => {
  clearInterval(pingInterval);
  wss.close();
});

// Helper function to broadcast to all connected clients
function broadcastUpdate(data) {
  const message = JSON.stringify(data);
  let sentCount = 0;
  let errorCount = 0;

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
        sentCount++;
      } catch (error) {
        console.error('Error sending WebSocket message:', error);
        errorCount++;
        // Remove dead connection
        clients.delete(client);
      }
    } else {
      // Remove closed connections
      clients.delete(client);
    }
  });

  if (sentCount > 0) {
    console.log(`📤 Broadcasted to ${sentCount} client(s)`);
  }
  if (errorCount > 0) {
    console.warn(`⚠️ Failed to send to ${errorCount} client(s)`);
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
    const { csv_data, version, project_input, concept_input, project_id } = req.body;

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
        project_id: project_id,
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
            project_id: savedDoc.project_id,
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

    // Calculate total tasks to be processed
    const totalInitialTasks = initialReactionData.length * initialReactionTraits.length;
    const totalContextTasks = contextPromptData.length * contextPromptTraits.length;
    mlExpectedCount = totalInitialTasks + totalContextTasks;
    mlReceivedCount = 0;
    isGenAiBatchTriggered = false;

    console.log(`🚀 Starting batch processing: ${mlExpectedCount} total ML tasks expected (${totalInitialTasks} initial + ${totalContextTasks} context).`);

    //    First: Queue initial_reaction data
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

app.use(express.text({ type: '*/*' }));

app.post('/trait-prediction', async (req, res) => {
  try {
    const { data, model_filename, type, project_id } = req.body;
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({ success: false });
    }

    const matchedTrait = traits.find(t => t.gcsFileName === model_filename);
    if (!matchedTrait) {
      return res.status(400).json({ success: false, error: 'Trait not found for ' + model_filename });
    }

    const traitTitle = matchedTrait.title;
    const fieldPrefix = type === 'INITIAL_REACTION' ? 'initial_reaction'
      : type === 'CONTEXT_PROMPT' ? 'context_prompt'
      : null;

    if (!fieldPrefix) {
      return res.status(400).json({ success: false, error: 'Invalid type' });
    }

    // Step 1: Save ML predictions to DB immediately (bulk)
    const bulkOps = data
      .filter(item => item?.ID)
      .map(item => {
        const mlScore = Number(item.commentPrediction);
        const update = {
          $push: {
            [`${fieldPrefix}.genAiRecords`]: {
              llmScore: mlScore,
              traitTitle,
              action: 'pending_genai',
              finalScore: mlScore,
              timestamp: new Date()
            }
          }
        };
        if (mlScore === 1) {
          update.$addToSet = { [`${fieldPrefix}.traits`]: traitTitle };
        }
        return { updateOne: { filter: { _id: item.ID }, update } };
      });

    if (bulkOps.length > 0) {
      await Trait.bulkWrite(bulkOps, { ordered: false });
    }

    // Step 2: Increment ML counter
    mlReceivedCount += bulkOps.length;
    console.log(`💾 ML saved: ${bulkOps.length} for ${traitTitle} (${type}) | Progress: ${mlReceivedCount}/${mlExpectedCount}`);

    // Step 3: Respond immediately
    res.status(200).json({
      success: true,
      stored: bulkOps.length,
      trait: traitTitle,
      mlProgress: { received: mlReceivedCount, expected: mlExpectedCount }
    });

    // Step 4: Check if ALL ML callbacks are received → trigger per-document GenAI tasks
    if (mlExpectedCount !== null && mlReceivedCount >= mlExpectedCount && !isGenAiBatchTriggered) {
      isGenAiBatchTriggered = true;
      console.log(`🎯 All ML predictions received (${mlReceivedCount}/${mlExpectedCount}). Enqueuing per-document GenAI tasks...`);

      broadcastUpdate({
        type: 'ml_collection_complete',
        message: 'All ML predictions collected. Starting GenAI validation...',
        received: mlReceivedCount,
        expected: mlExpectedCount,
        timestamp: new Date().toISOString()
      });

      const pendingDocs = await Trait.find({ processed: false });

      // Parent-child check on ML traits[] before GenAI
      for (const doc of pendingDocs) {
        let changed = false;
        for (const field of ['initial_reaction', 'context_prompt']) {
          const target = doc[field];
          if (!target || !target.traits || target.traits.length === 0) continue;
          const traitSet = new Set(target.traits);
          for (const childTrait of [...traitSet]) {
            const parents = PARENT_CHILD_MAP[childTrait];
            if (!parents) continue;
            const hasParent = parents.some(p => traitSet.has(p));
            if (!hasParent) {
              console.log(`🚫 ${childTrait} removed from ${field}.traits[] — parent not present (needs: ${parents.join(' or ')})`);
              traitSet.delete(childTrait);
              changed = true;
            }
          }
          target.traits = Array.from(traitSet);
        }
        if (changed) await doc.save();
      }
      console.log(`✅ Parent-child validation done for ${pendingDocs.length} documents`);

      genAiExpectedDocs = pendingDocs.length;
      genAiProcessedDocs = 0;

      const genAiQueue = require('./GenAiQueueService');
      for (const doc of pendingDocs) {
        await genAiQueue.enqueueGenAiForDocument(doc._id.toString());
      }
      console.log(`📤 Enqueued ${pendingDocs.length} per-document GenAI tasks`);
    }

  } catch (err) {
    console.error('❌ /trait-prediction error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
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
    const { documentId, traitName, feedback, type, genAiRecordId, isTraitValidationIncorrect } = req.body;

    if (!documentId || !traitName || !type) {
      return res.status(400).json({
        success: false,
        error: 'documentId, traitName, and type are required'
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

    // Calculate new values
    const currentFinalScore = existing.finalScore ?? 0;
    const newFinalScore = isTraitValidationIncorrect; // Frontend sends 0 or 1 directly
    const newAction = newFinalScore !== currentFinalScore ? 'Score change via feedback' : (existing.action ?? 'No change');

    const newGenAiSays = {
      ...existing.genAiSays,
      validationIncorrect: isTraitValidationIncorrect
    };

    const historyEntry = {
      finalScore: currentFinalScore,
      action: newAction,
      feedback: feedback,
      genAiSays: newGenAiSays,
      timestamp: new Date()
    };

    const history = existing.history ? [...existing.history] : [];
    history.push(historyEntry);

    // Update the record
    const recordToUpdate = existing.toObject ? existing.toObject() : { ...existing };

    target.genAiRecords[recordIndex] = {
      ...recordToUpdate,
      llmScore: existing.llmScore ?? 0,
      traitTitle: existing.traitTitle ?? traitName,
      finalScore: newFinalScore,
      action: newAction,
      isTraitValidationIncorrect: isTraitValidationIncorrect,
      feedback,
      history: history
    };

    // Update traits array based on new finalScore
    const hasTrait = target.traits.includes(traitName);
    if (newFinalScore === 1 && !hasTrait) {
      target.traits.push(traitName);
    } else if (newFinalScore === 0 && hasTrait) {
      target.traits = target.traits.filter(t => t !== traitName);
    }

    await doc.save();

    // Broadcast update to all connected clients
    broadcastUpdate({
      type: 'feedback_added',
      documentId: documentId,
      traitName: traitName,
      feedbackType: type,
      updatedDoc: doc,
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      message: 'Feedback added to genAiRecord',
      updatedDoc: doc
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
      updatedDoc: doc
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

// Update review status
app.post('/api/traits/status', async (req, res) => {
  try {
    const { documentId, isReviewed } = req.body;

    if (!documentId) {
      return res.status(400).json({
        success: false,
        error: 'documentId is required'
      });
    }

    const updatedDoc = await Trait.findByIdAndUpdate(
      documentId,
      { $set: { review_status: !!isReviewed } },
      { new: true }
    );

    if (!updatedDoc) {
      return res.status(404).json({
        success: false,
        error: 'Document not found'
      });
    }

    broadcastUpdate({
      type: 'review_status_updated',
      documentId: documentId,
      updatedDoc: updatedDoc,
      timestamp: new Date().toISOString()
    });

   return res.json({
      success: true,
      message: 'Review status updated successfully',
      data: updatedDoc
    });
  } catch (error) {
    console.error('Error updating review status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get statistics/summary
app.get('/api/traits/db/stats', async (req, res) => {
  try {
    const totalTraits = await Trait.countDocuments({ processed: false });
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
app.post('/genai-batch-worker', async (req, res) => {
  try {
    const { documentId } = req.body;
    if (!documentId) {
      return res.status(400).json({ success: false, error: 'documentId is required' });
    }

    res.status(200).send('OK');

    setImmediate(async () => {
      try {
        console.log(`🚀 GenAI processing document: ${documentId}`);

        await processDocumentGenAi(documentId);
        await Trait.updateOne({ _id: documentId }, { $set: { processed: true } });

        genAiProcessedDocs++;
        console.log(`📈 GenAI progress: ${genAiProcessedDocs}/${genAiExpectedDocs}`);

        if (genAiExpectedDocs > 0 && genAiProcessedDocs >= genAiExpectedDocs) {
          broadcastUpdate({
            type: 'process_completed',
            message: 'All GenAI validations completed. Please refresh to fetch latest data.',
            processed: genAiProcessedDocs,
            total: genAiExpectedDocs,
            timestamp: new Date().toISOString()
          });

          console.log(`🎊 All ${genAiExpectedDocs} documents processed with GenAI`);

          mlReceivedCount = 0;
          mlExpectedCount = null;
          isGenAiBatchTriggered = false;
          genAiExpectedDocs = 0;
          genAiProcessedDocs = 0;
        }
      } catch (docErr) {
        genAiProcessedDocs++;
        console.error(`❌ GenAI failed for doc ${documentId}:`, docErr.message);

        if (genAiExpectedDocs > 0 && genAiProcessedDocs >= genAiExpectedDocs) {
          broadcastUpdate({
            type: 'process_completed',
            message: 'GenAI validations completed (with some errors).',
            processed: genAiProcessedDocs,
            total: genAiExpectedDocs,
            timestamp: new Date().toISOString()
          });

          mlReceivedCount = 0;
          mlExpectedCount = null;
          isGenAiBatchTriggered = false;
          genAiExpectedDocs = 0;
          genAiProcessedDocs = 0;
        }
      }
    });

  } catch (err) {
    console.error('❌ Batch worker endpoint crashed:', err);
    res.status(500).send('Internal Server Error');
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

// ML callback counter: tracks received ML predictions vs expected total
let mlReceivedCount = 0;
let mlExpectedCount = null;
let isGenAiBatchTriggered = false;

// GenAI per-document completion tracking
let genAiExpectedDocs = 0;
let genAiProcessedDocs = 0;

// Child → Parent(s) map: secondary trait is valid only if at least one parent is present
const PARENT_CHILD_MAP = {
  "(INTUITIVE) Good Brand": ["Intuitive"],
  "(INTUITIVE) Ingredient Appeal": ["Intuitive"],
  "(INTUITIVE) Makes Life Easier": ["Intuitive"],
  "(EMOTIVE DELIGHT) Ingredient Love": ["Emotive Delight"],
  "(EMOTIVE DELIGHT) Makes Life Easier!": ["Emotive Delight"],
  "(EMOTIVE DELIGHT) Brand Love": ["Emotive Delight"],
  "(EMOTIVE DELIGHT) Flavor Love": ["Emotive Delight"],
  "(FORESIGHT) Expressed Intent": ["Foresight"],
  "(FORESIGHT-NICHE) Dietary Issues - Special Diets": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(FORESIGHT-NICHE) Gift": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(FORESIGHT-NICHE) Health Conditions": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(FORESIGHT-NICHE) Holiday": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(FORESIGHT-NICHE) Kids": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(FORESIGHT-NICHE) Seasonal": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(FORESIGHT-NICHE) Special Occasion - Event": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(FORESIGHT-NICHE) Travel": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(FORESIGHT-NICHE) Social Gatherings": ["Foresight", "Niche (Initial)", "Niche (Prompted)"],
  "(NEUTRALITY-NEGATIVITY) Too Much Work": ["Negativity"],
  "(SKEPTICAL) Hopeful Skepticism": ["Skeptical"],
  "(SKEPTICAL) Taste Skepticism": ["Skeptical"],
  "(NOT FOR ME) Flavor": ["Not For Me"],
  "(NOT FOR ME) Brand": ["Not For Me"],
  "(NOT FOR ME) Outright Rejection": ["Not For Me"],
  "(NOT FOR ME) Ingredient": ["Not For Me"],
  "(NEW NEWS) Eye Catching": ["New News"],
};

/**
 * Process one document with GenAI: call classifyAll once per reaction text,
 * then update ALL pending genAiRecords for that document.
 */
async function processDocumentGenAi(documentId) {
  const doc = await Trait.findById(documentId);
  if (!doc) throw new Error(`Document not found: ${documentId}`);

  let versionToPass = 'basic';
  let projectInput = '';
  let conceptInput = '';

  if (doc.version === 'context') {
    versionToPass = 'context';
    projectInput = doc.project_input || '';
    conceptInput = doc.concept_input || '';
  }

  const fieldsToProcess = [];

  if (doc.initial_reaction?.text) {
    fieldsToProcess.push({ fieldPrefix: 'initial_reaction', text: doc.initial_reaction.text });
  }
  if (doc.context_prompt?.text) {
    fieldsToProcess.push({ fieldPrefix: 'context_prompt', text: doc.context_prompt.text });
  }

  for (const { fieldPrefix, text } of fieldsToProcess) {
    const target = doc[fieldPrefix];
    const pendingRecords = (target.genAiRecords || []).filter(r => r.action === 'pending_genai');

    if (pendingRecords.length === 0) continue;

    console.log(`🚀 GenAI classifyAll | ID=${documentId} | field=${fieldPrefix} | pending=${pendingRecords.length}`);

    const bulkResult = await genAiService.classifyAll(text, versionToPass, projectInput, conceptInput, fieldPrefix);
    if (!bulkResult?.success) {
      throw new Error(`GenAI classifyAll failed for ${documentId} (${fieldPrefix}): ${bulkResult?.error}`);
    }

    const bulkData = bulkResult.data;
    const updatedReviewTags = new Set(target.reviewTags || []);

    for (const record of pendingRecords) {
      const traitTitle = record.traitTitle;
      const genAiResponse = genAiService.extractTraitFromBulk(bulkData, traitTitle);

      if (!genAiResponse) {
        console.warn(`⚠️ No GenAI row for "${traitTitle}" in bulk response | ID=${documentId}`);
        record.action = 'no_genai_response';
        record.timestamp = new Date();
        continue;
      }

      const llmScore = record.llmScore;
      const { action, finalScore } = genAiService.determineAction(llmScore, genAiResponse);
      const needsReview = genAiService.requiresReview(genAiResponse, llmScore);

      record.genAiSays = {
        present: genAiResponse.present,
        confidence: genAiResponse.confidence,
        rationale: genAiResponse.rationale,
        score: genAiResponse.score
      };
      record.finalScore = finalScore;
      record.action = action;
      record.timestamp = new Date();

      if (needsReview) {
        updatedReviewTags.add(traitTitle);
      }

      console.log(`  ✅ ${traitTitle} | LLM=${llmScore} GenAI=${genAiResponse.present ? 1 : 0} → Final=${finalScore} (${action})`);
    }

    target.reviewTags = Array.from(updatedReviewTags);

    // Build traits[] from ML (llmScore=1) with dedup, then apply parent-child filter
    const mlTraitSet = new Set();
    for (const record of target.genAiRecords || []) {
      if (record.llmScore === 1) {
        mlTraitSet.add(record.traitTitle);
      }
    }

    for (const childTrait of [...mlTraitSet]) {
      const parents = PARENT_CHILD_MAP[childTrait];
      if (!parents) continue;
      const hasParent = parents.some(p => mlTraitSet.has(p));
      if (!hasParent) {
        console.log(`  🚫 ${childTrait} removed from ${fieldPrefix}.traits[] — ML parent not present (needs: ${parents.join(' or ')})`);
        mlTraitSet.delete(childTrait);
      }
    }

    target.traits = Array.from(mlTraitSet);
  }

  await doc.save();

  broadcastUpdate({
    type: 'document_genai_complete',
    documentId,
    updatedDoc: doc,
    timestamp: new Date().toISOString()
  });

  return { success: true, documentId };
}

