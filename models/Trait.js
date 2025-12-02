const mongoose = require('mongoose');

/**
 * Trait Schema
 * Stores trait predictions/results for text analysis
 */
const traitSchema = new mongoose.Schema(
  {
    // Main fields
    project_input: {
      type: String,
      required: true,
      index: true
    },
    concept_input: {
      type: String,
      default: ''
    },
    version: {
      type: String,
      required: true,
      enum: ['context', 'basic'],
      index: true
    },
    // Initial Reaction Object
    initial_reaction: {
      text: {
        type: String,
        default: ''
      },
      traits: {
        type: [String],
        default: []
      },
      genAiRecords: {
        type: [{
          llmScore: {
            type: Number,
            required: true
          },
          genAiSays: {
            present: Boolean,
            confidence: Number,
            rationale: String,
            score: Number
          },
          finalScore: {
            type: Number,
            required: true
          },
          action: {
            type: String,
            enum: ['No change', 'Score removed', 'Score added', 'Human review required'],
            required: true
          },
          traitTitle: String,
          timestamp: {
            type: Date,
            default: Date.now
          }
        }],
        default: []
      },
      type: {
        type: String,
        enum: ['INITIAL_REACTION'],
        default: 'INITIAL_REACTION'
      },
      _id: {
        type: mongoose.Schema.Types.ObjectId,
        default: () => new mongoose.Types.ObjectId()
      },
      reviewTags: {
        type: [String],
        default: []
      }
    },
    // Context Prompt Object
    context_prompt: {
      text: {
        type: String,
        default: ''
      },
      traits: {
        type: [String],
        default: []
      },
      genAiRecords: {
        type: [{
          llmScore: {
            type: Number,
            required: true
          },
          genAiSays: {
            present: Boolean,
            confidence: Number,
            rationale: String,
            score: Number
          },
          finalScore: {
            type: Number,
            required: true
          },
          action: {
            type: String,
            enum: ['No change', 'Score removed', 'Score added', 'Human review required'],
            required: true
          },
          traitTitle: String,
          timestamp: {
            type: Date,
            default: Date.now
          }
        }],
        default: []
      },
      reviewTags: {
        type: [String],
        default: []
      },
      type: {
        type: String,
        enum: ['CONTEXT_PROMPT'],
        default: 'CONTEXT_PROMPT'
      },
      _id: {
        type: mongoose.Schema.Types.ObjectId,
        default: () => new mongoose.Types.ObjectId()
      }
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt fields
    collection: 'traits' // Explicit collection name
  }
);

// Compound indexes for efficient queries
traitSchema.index({ project_input: 1, version: 1, createdAt: -1 });
traitSchema.index({ 'initial_reaction._id': 1 });
traitSchema.index({ 'context_prompt._id': 1 });
traitSchema.index({ version: 1, createdAt: -1 });

// Instance method to add a trait
traitSchema.methods.addTrait = function(trait) {
  if (!this.traits.includes(trait)) {
    this.traits.push(trait);
  }
  return this;
};

// Instance method to remove a trait
traitSchema.methods.removeTrait = function(trait) {
  this.traits = this.traits.filter(t => t !== trait);
  return this;
};

// Static method to find by type
traitSchema.statics.findByType = function(type) {
  return this.find({ type });
};

// Static method to find by trait name
traitSchema.statics.findByTrait = function(traitName) {
  return this.find({ traits: { $in: [traitName] } });
};

const Trait = mongoose.model('Trait', traitSchema);

module.exports = Trait;

