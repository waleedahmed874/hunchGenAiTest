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

    const projectId = project_input || "691f0de3cde91b17bbb84746";

    // Map csv_data and save to database
    const savedDocuments = [];
    
    for (const item of csv_data) {
      // Prepare data structure for saving
      const traitData = {
        project_input: project_input || projectId,
        concept_input: concept_input || '',
        version: versionLower
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
                
        await Trait.create(traitData);
        
      }

   
    }


    // Fetch saved documents from database
    const allSavedDocs = await Trait.find({
      project_input: project_input || projectId,
      version: versionLower
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

    // Then: Queue context_prompt data
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
          }
        } catch (error) {
          console.error(`Error queuing CONTEXT_PROMPT task for ${model.title}:`, error);
        }
      }
    }

    res.json({
      success: true,
      message: 'Data saved and tasks queued successfully',
      savedDocuments: savedDocuments.map(doc => ({
        mongoId: doc.mongoId,
        type: doc.type
      })),
      projectId,
      conceptInput: concept_input,
      version: versionLower,
  
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

        // Find document by MongoDB ID
        let traitDoc = await Trait.findById(ID);
        
        if (!traitDoc) {
          errors.push({ item, error: `Document not found for ID: ${ID}` });
          continue;
        }

        // Get text from the appropriate object based on type
        let text;
        let targetObject;
        
        if (type === 'INITIAL_REACTION') {
          if (!traitDoc.initial_reaction || !traitDoc.initial_reaction.text) {
            errors.push({ item, error: `Initial reaction text not found for ID: ${ID}` });
            continue;
          }
          text = traitDoc.initial_reaction.text;
          targetObject = traitDoc.initial_reaction;
        } else if (type === 'CONTEXT_PROMPT') {
          if (!traitDoc.context_prompt || !traitDoc.context_prompt.text) {
            errors.push({ item, error: `Context prompt text not found for ID: ${ID}` });
            continue;
          }
          text = traitDoc.context_prompt.text;
          targetObject = traitDoc.context_prompt;
        } else {
          errors.push({ item, error: `Invalid type: ${type}` });
          continue;
        }

        const llmScore = commentPrediction; // 0 or 1

        // Call GenAI API
        console.log(`🔍 Calling GenAI for ID: ${ID}, trait: ${traitTitle}, type: ${type}`);
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

        // Add GenAI record to the appropriate object
        if (!targetObject.genAiRecords) {
          targetObject.genAiRecords = [];
        }
        targetObject.genAiRecords.push(genAiRecord);

        // Handle trait addition/removal based on final score
        if (!targetObject.traits) {
          targetObject.traits = [];
        }
        const hasTrait = targetObject.traits.includes(traitTitle);

        if (finalScore === 1 && !hasTrait) {
          // Add trait if final score is 1 and trait not already present
          targetObject.traits.push(traitTitle);
          console.log(`➕ Added trait "${traitTitle}" for ID: ${ID}`);
        } else if (finalScore === 0 && hasTrait) {
          // Remove trait if final score is 0 and trait is present
          targetObject.traits = targetObject.traits.filter(t => t !== traitTitle);
          console.log(`➖ Removed trait "${traitTitle}" for ID: ${ID}`);
        }

        // Add review tag if human review is required
        if (needsReview) {
          if (!targetObject.reviewTags) {
            targetObject.reviewTags = [];
          }
          const reviewTag = traitTitle;
          if (!targetObject.reviewTags.includes(reviewTag)) {
            targetObject.reviewTags.push(reviewTag);
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
