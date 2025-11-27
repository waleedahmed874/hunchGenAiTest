require('dotenv').config();
const express = require('express');
const cors = require('cors');
const database = require('./db');
const { traits } = require('./traits');
const { initialReactions, contextPrompts } = require('./reaction');
const GCloudService = require('./gcloudService');
const Trait = require('./models/Trait');
const genAiService = require('./services/genAiService');

const app = express();
const PORT = process.env.PORT || 3000;
const gcloudService = new GCloudService();

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
      ID: prompt.id,
      comment: gcloudService.cleanText(prompt.text),
    }));

    // Prepare initial reaction results
    const resultsToPost = initialReactions
      .map((reaction) => ({
        ID:reaction.id,
        comment: gcloudService.cleanText(reaction.text),
      }));

    const projectId = "691f0de3cde91b17bbb84746";

   

    // Queue tasks for context prompt enabled traits
    for (const model of traits.filter(trait => trait.contextPromptEnabled)) {
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
    for (const model of traits.filter(trait => trait.initialReactionEnabled)) {
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
      return res.status(400).json({
        success: false,
        error: `Trait not found for model filename: ${model_filename}`
      });
    }

    const traitTitle = matchedTrait.title;
    const traitDefinition = matchedTrait.trait_definition || '';
    const traitExamples = matchedTrait.trait_examples || '';

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
        const llmScore = commentPrediction; // 0 or 1

        // Call GenAI API
        console.log(`🔍 Calling GenAI for ID: ${ID}, trait: ${traitTitle}`);
        const genAiResult = await genAiService.classify(
          text,
          traitTitle,
          traitDefinition,
          traitExamples,
          'basic'
        );

        if (!genAiResult.success) {
          console.error(`❌ GenAI API failed for ID: ${ID}`, genAiResult.error);
          errors.push({ item, error: `GenAI API failed: ${genAiResult.error}` });
          continue;
        }

        const genAiResponse = genAiResult.data;
        const genAiScore = genAiResponse.present ? 1 : 0;

        // Determine action based on LLM score and GenAI response
        const actionResult = genAiService.determineAction(llmScore, genAiResponse);
        const { action, finalScore } = actionResult;

        // Check if human review is required
        const needsReview = genAiService.requiresReview(genAiResponse, llmScore);
        if (needsReview) {
          console.log(`⚠️ Human review required for ID: ${ID}`);
        }

        // Find or create Trait document using upsert (unique by text + type)
        let traitDoc = await Trait.findOne({ text, type });

        if (!traitDoc) {
          // Create new document if it doesn't exist
          traitDoc = new Trait({
            text,
            type,
            traits: [],
            genAiRecords: [],
            reviewTags: []
          });
        }

        // Create GenAI record
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

        // Add GenAI record to document
        traitDoc.genAiRecords.push(genAiRecord);

        // Handle trait addition/removal based on final score
        const hasTrait = traitDoc.traits.includes(traitTitle);

        if (finalScore === 1 && !hasTrait) {
          // Add trait if final score is 1 and trait not already present
          traitDoc.traits.push(traitTitle);
          console.log(`➕ Added trait "${traitTitle}" for ID: ${ID}`);
        } else if (finalScore === 0 && hasTrait) {
          // Remove trait if final score is 0 and trait is present
          traitDoc.traits = traitDoc.traits.filter(t => t !== traitTitle);
          console.log(`➖ Removed trait "${traitTitle}" for ID: ${ID}`);
        }

        // Add review tag if human review is required
        if (needsReview) {
          const reviewTag = traitTitle;
          if (!traitDoc.reviewTags.includes(reviewTag)) {
            traitDoc.reviewTags.push(reviewTag);
          }
        }

        // Save the document
        const savedTrait = await traitDoc.save();
        
        // Only add to savedTraits once per unique ID
        if (!processedIds.has(ID)) {
          savedTraits.push(savedTrait);
          processedIds.add(ID);
        }

        console.log(`✅ Processed ID: ${ID} | LLM: ${llmScore} | GenAI: ${genAiScore} | Final: ${finalScore} | Action: ${action}`);
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

// ==================== Trait Database Fetch APIs ====================

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
