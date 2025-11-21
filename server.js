require('dotenv').config();
const express = require('express');
const { traits } = require('./traits');
const { initialReactions, contextPrompts } = require('./reaction');
const GCloudService = require('./gcloudService');

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
    const contextPromptResultsToPost = contextPrompts.map((prompt) => ({
      ID: generateObjectId(),
      comment: gcloudService.cleanText(prompt),
    }));

    // Prepare initial reaction results
    const resultsToPost = initialReactions
      .filter(reaction => reaction) // Filter out null/undefined values
      .map((reaction) => ({
        ID: generateObjectId(),
        comment: gcloudService.cleanText(reaction),
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

    res.json({
      success: true,
      message: 'Trait prediction callback received',
      receivedData: {
        dataCount: Array.isArray(data) ? data.length : 'N/A',
        model_filename,
        project_id,
        type
      }
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

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:3000`);
});
