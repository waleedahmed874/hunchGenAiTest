require('dotenv').config();
const express = require('express');
const database = require('./db');
const { traits } = require('./traits');
const { initialReactions, contextPrompts } = require('./reaction');
const GCloudService = require('./gcloudService');
const Trait = require('./models/Trait');

const app = express();
const PORT = process.env.PORT || 3000;
const gcloudService = new GCloudService();

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
  res.json({
    success: true,
    count: traits.length,
    data: traits
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
    // Prepare context prompt results
    const contextPromptResultsToPost = contextPrompts.filter(prompt => prompt.contextPromptEnabled===true).map((prompt) => ({
      ID: prompt.id,
      comment: gcloudService.cleanText(prompt.text),
    }));

    // Prepare initial reaction results
    const resultsToPost = initialReactions.filter(reaction => reaction.initialReactionEnabled===true)
      .map((reaction) => ({
        ID:reaction.id,
        comment: gcloudService.cleanText(reaction.text),
      }));

    const projectId = "691f0de3cde91b17bbb84746";

   

    // Queue tasks for context prompt enabled traits
    for (const model of traits) {
      try {
        if (model.gcsFileName && contextPromptResultsToPost && projectId && model.contextPromptEnabled) {
          const response = await gcloudService.queueTraitTasks(
            contextPromptResultsToPost,
            projectId,
            model.gcsFileName,
            'CONTEXT_PROMPT'
          );
          
        }
      } catch (error) {
        console.log('Error queuing context prompt task:', error);
      }
    }

    // Queue tasks for initial reaction enabled traits
    for (const model of traits) {
      try {
        if (model.initialReactionEnabled && model.gcsFileName && resultsToPost && projectId) {
          const response = await gcloudService.queueTraitTasks(
            resultsToPost,
            projectId,
            model.gcsFileName,
            'INITIAL_REACTION'
          );
          
     
        }
      } catch (error) {
        console.log('Error queuing initial reaction task:', model, error);
      }
    }

    res.json({
      success: true,
   
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
    const { data, model_filename, project_id, type } = req.body;
    
    console.log('=== Trait Prediction Callback ===');
    console.log('Data:', data);
    console.log('Model Filename:', model_filename);
    console.log('Project ID:', project_id);
    console.log('Type:', type);
    console.log('================================');

    // Validate required fields
    if (!data || !Array.isArray(data)) {
      return res.status(400).json({
        success: false,
        error: 'Data must be a valid array'
      });
    }

    if (!model_filename || !type) {
      return res.status(400).json({
        success: false,
        error: 'Model filename and type are required'
      });
    }

    // Find trait from traits.js by matching gcsFileName with model_filename
    const matchedTrait = traits.find(trait => trait.gcsFileName === model_filename);
    if (!matchedTrait) {
      console.warn(`Trait not found for model filename: ${model_filename}`);
    }

    const traitTitle = matchedTrait ? matchedTrait.title : null;

    // Get the appropriate reactions array based on type
    const reactionsArray = type === 'INITIAL_REACTION' ? initialReactions : contextPrompts;

    // Process each data item
    const savedTraits = [];
    const errors = [];
    const processedIds = new Set(); // Track processed IDs to avoid duplicates in response

    for (const item of data) {
      try {
        const { ID, commentPrediction } = item;

        if (!ID) {
          errors.push({ item, error: 'ID is missing' });
          continue;
        }

        // Find matching text from reaction.js by ID
        const matchedReaction = reactionsArray.find(reaction => reaction.id === ID);
        
        if (!matchedReaction) {
          errors.push({ item, error: `Reaction not found for ID: ${ID}` });
          continue;
        }

        const text = matchedReaction.text;

        // Find or create Trait document using upsert (unique by text + type)
        let traitDoc = await Trait.findOne({ text, type });

        if (!traitDoc) {
          // Create new document if it doesn't exist
          traitDoc = new Trait({
            text,
            type,
            traits: []
          });
        }

        // Add trait to array if commentPrediction is 1 and trait title exists
        if (commentPrediction === 1 && traitTitle) {
          // Add trait only if it doesn't already exist (avoid duplicates)
          if (!traitDoc.traits.includes(traitTitle)) {
            traitDoc.traits.push(traitTitle);
          }
        }

        // Save the document
        const savedTrait = await traitDoc.save();
        
        // Only add to savedTraits once per unique ID
        if (!processedIds.has(ID)) {
          savedTraits.push(savedTrait);
          processedIds.add(ID);
        }

        console.log(`✅ Processed ID: ${ID}, commentPrediction: ${commentPrediction}, trait: ${commentPrediction === 1 && traitTitle ? traitTitle : 'none'}`);
      } catch (itemError) {
        console.error(`Error processing item ${item.ID}:`, itemError);
        errors.push({ item, error: itemError.message });
      }
    }

    res.json({
      success: true,
      message: 'Trait prediction callback processed',
      saved: savedTraits.length,
      errors: errors.length,
      receivedData: {
        dataCount: data.length,
        model_filename,
        project_id,
        type,
        traitTitle
      },
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error handling trait prediction callback:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
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
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`Server is running on ${PORT}`);
      console.log(`Database status: ${database.getStatus()}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the application
startServer();
