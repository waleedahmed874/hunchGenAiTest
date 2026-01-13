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
      index: true
    }, project_id: {
      type: String,
    },
    processed: {
      type: Boolean,
      default: false
    },
    concept_input: {
      type: String,
      default: ''
    },
    hunch_id: {
      type: String,
      default: ''
    },
    concept_name: {
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
      feedback: {
        type: [
          {
            trait: String,
            text: String,
            shouldExist: Boolean,

          }
        ]
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
          feedback: {
            type: String,
            default: ''
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
            // enum: ['No change', 'Score removed', 'Score added', 'Human review required', 'Score change via feedback'],
            required: true
          },
          traitTitle: String,
          timestamp: {
            type: Date,
            default: Date.now
          },
          history: {
            type: [{
              finalScore: Number,
              action: String,
              feedback: String,
              genAiSays: {
                present: Boolean,
                confidence: Number,
                rationale: String,
                score: Number,
                validationIncorrect: Boolean
              },
              timestamp: {
                type: Date,
                default: Date.now
              }
            }],
            default: []
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
      feedback: {
        type: [
          {
            trait: String,
            text: String,
            shouldExist: Boolean,

          }
        ]
      },
      genAiRecords: {
        type: [{
          llmScore: {
            type: Number,
            required: true
          },
          feedback: {
            type: String,
            default: ''
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
            // enum: ['No change', 'Score removed', 'Score added', 'Human review required', 'Score change via feedback'],
            required: true
          },
          traitTitle: String,
          timestamp: {
            type: Date,
            default: Date.now
          },
          history: {
            type: [{
              finalScore: Number,
              action: String,
              feedback: String,
              genAiSays: {
                present: Boolean,
                confidence: Number,
                rationale: String,
                score: Number,
                validationIncorrect: Boolean
              },
              timestamp: {
                type: Date,
                default: Date.now
              }
            }],
            default: []
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
traitSchema.methods.addTrait = function (trait) {
  if (!this.traits.includes(trait)) {
    this.traits.push(trait);
  }
  return this;
};

// Instance method to remove a trait
traitSchema.methods.removeTrait = function (trait) {
  this.traits = this.traits.filter(t => t !== trait);
  return this;
};

// Static method to find by type
traitSchema.statics.findByType = function (type) {
  return this.find({ type });
};

// Static method to find by trait name
traitSchema.statics.findByTrait = function (traitName) {
  return this.find({ traits: { $in: [traitName] } });
};

const Trait = mongoose.model('Trait', traitSchema);

module.exports = Trait;

