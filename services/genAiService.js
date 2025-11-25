const axios = require('axios');

/**
 * GenAI Service
 * Handles communication with the GenAI classification API
 */
class GenAiService {
  constructor() {
    this.apiUrl = 'https://data-science-dev-git-320866101884.us-central1.run.app/classify';
    this.confidenceThreshold = 0.90;
    this.reviewThreshold = 0.70; // Lower threshold for human review
  }

  /**
   * Call GenAI classify API
   * @param {string} text - The reaction text to classify
   * @param {string} traitTitle - The trait title
   * @param {string} traitDefinition - The trait definition
   * @param {string} traitExamples - The trait examples
   * @param {string} version - API version (default: 'basic')
   * @returns {Promise<Object>} GenAI response
   */
  async classify(text, traitTitle, traitDefinition, traitExamples, version = 'basic') {
    try {
      const payload = {
        text,
        trait_title: traitTitle,
        trait_definition: traitDefinition,
        trait_examples: traitExamples,
        version
      };

      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 seconds timeout
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('GenAI API Error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      return {
        success: false,
        error: error.message,
        data: null
      };
    }
  }

  /**
   * Determine if human review is required
   * @param {Object} genAiResponse - GenAI API response
   * @param {number} llmScore - Original LLM score (commentPrediction)
   * @returns {boolean} Whether human review is required
   */
  requiresReview(genAiResponse, llmScore) {
    if (!genAiResponse || !genAiResponse.present) {
      return false;
    }

    const { confidence, present } = genAiResponse;
    const genAiScore = present ? 1 : 0;

    // Review required if confidence is below threshold
    if (confidence < this.reviewThreshold) {
      return true;
    }

    // Review required if GenAI changed the score
    if (genAiScore !== llmScore) {
      return true;
    }

    return false;
  }

  /**
   * Determine the action based on LLM score and GenAI response
   * @param {number} llmScore - Original LLM score (commentPrediction)
   * @param {Object} genAiResponse - GenAI API response
   * @returns {Object} Action details
   */
  determineAction(llmScore, genAiResponse) {
    if (!genAiResponse || genAiResponse.success === false) {
      return {
        action: 'No change',
        finalScore: llmScore,
        reason: 'GenAI API failed'
      };
    }

    const { present, confidence } = genAiResponse;
    const genAiScore = present ? 1 : 0;

    // Skip if score > 0.90 AND present === true AND current commentPrediction === 1
    if (llmScore === 1 && present === true && confidence > this.confidenceThreshold) {
      return {
        action: 'No change',
        finalScore: 1,
        reason: 'High confidence match, no change needed'
      };
    }

    // If commentPrediction === 0 AND present === true AND confidence > 0.90: add trait
    if (llmScore === 0 && present === true && confidence > this.confidenceThreshold) {
      return {
        action: 'Score added',
        finalScore: 1,
        reason: 'GenAI confirmed trait presence with high confidence'
      };
    }

    // If commentPrediction === 1 AND present === false: remove trait
    if (llmScore === 1 && present === false && confidence > this.confidenceThreshold) {
      return {
        action: 'Score removed',
        finalScore: 0,
        reason: 'GenAI confirmed trait absence with high confidence'
      };
    }

    // If scores match but confidence is low, or if GenAI changed score
    if (this.requiresReview(genAiResponse, llmScore)) {
      return {
        action: 'Human review required',
        finalScore: llmScore, // Keep original score until review
        reason: 'Low confidence or score change detected'
      };
    }

    // Default: no change
    return {
      action: 'No change',
      finalScore: llmScore,
      reason: 'No significant change detected'
    };
  }
}

module.exports = new GenAiService();

