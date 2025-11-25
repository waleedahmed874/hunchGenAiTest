const mongoose = require('mongoose');

/**
 * Trait Schema
 * Stores trait predictions/results for text analysis
 */
const traitSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: [true, 'Text is required'],
      trim: true,
      index: true // Index for faster text searches
    },
    type: {
      type: String,
      required: [true, 'Type is required'],
      enum: {
        values: ['INITIAL_REACTION', 'CONTEXT_PROMPT'],
        message: 'Type must be either INITIAL_REACTION or CONTEXT_PROMPT'
      },
      index: true // Index for filtering by type
    },
    traits: {
      type: [String],
      required: [true, 'Traits array is required'],
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
    }
  },
  {
    timestamps: true, // Adds createdAt and updatedAt fields
    collection: 'traits' // Explicit collection name
  }
);

// Compound index for efficient queries
traitSchema.index({ type: 1, createdAt: -1 });

// Unique compound index to ensure one entry per text + type combination
traitSchema.index({ text: 1, type: 1 }, { unique: true });

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

