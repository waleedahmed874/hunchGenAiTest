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
        trait: traitTitle,
        trait_definition: traitDefinition,
        trait_examples: traitExamples,
        version
      };
console.log('payload============================',payload)
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
   * Human review is required ONLY when score is changing AND confidence < 0.90
   * @param {Object} genAiResponse - GenAI API response
   * @param {number} llmScore - Original LLM score (commentPrediction)
   * @returns {boolean} Whether human review is required
   */
  requiresReview(genAiResponse, llmScore) {
    if (!genAiResponse || genAiResponse.present === undefined) {
      return false;
    }

    const { confidence, present } = genAiResponse;
    const genAiScore = present ? 1 : 0;

    // Review required ONLY if score is changing AND confidence < 0.90
    if (genAiScore !== llmScore && confidence < this.confidenceThreshold) {
      return true;
    }

    return false;
  }

  /**
   * Determine the action based on LLM score and GenAI response
   * Decision Matrix:
   * - LLM Score = 1, GenAI Says = Yes (conf > 0.90) → Final Score = 1, Action = No change
   * - LLM Score = 1, GenAI Says = No (conf > 0.90) → Final Score = 0, Action = Score removed
   * - LLM Score = 0, GenAI Says = Yes (conf > 0.90) → Final Score = 1, Action = Score added
   * - LLM Score = 0, GenAI Says = No → Final Score = 0, Action = No change
   * - Score changing AND confidence < 0.90 → Final Score = Original, Action = Human review required
   * 
   * @param {number} llmScore - Original LLM score (commentPrediction)
   * @param {Object} genAiResponse - GenAI API response
   * @returns {Object} Action details
   */
  determineAction(llmScore, genAiResponse) {
    if (!genAiResponse || genAiResponse.present === undefined) {
      return {
        action: 'No change',
        finalScore: llmScore,
        reason: 'GenAI API failed or invalid response'
      };
    }

    const { present, confidence } = genAiResponse;
    const genAiScore = present ? 1 : 0;

    // Check if human review is required (score changing AND confidence < 0.90)
    if (this.requiresReview(genAiResponse, llmScore)) {
      return {
        action: 'Human review required',
        finalScore: llmScore, // Keep original score until review
        reason: 'Score change detected with low confidence (< 0.90)'
      };
    }

    // LLM Score = 1, GenAI Says = Yes (conf > 0.90) → No change
    if (llmScore === 1 && present === true && confidence > this.confidenceThreshold) {
      return {
        action: 'No change',
        finalScore: 1,
        reason: 'High confidence match, no change needed'
      };
    }

    // LLM Score = 1, GenAI Says = No (conf > 0.90) → Score removed
    if (llmScore === 1 && present === false && confidence > this.confidenceThreshold) {
      return {
        action: 'Score removed',
        finalScore: 0,
        reason: 'GenAI confirmed trait absence with high confidence'
      };
    }

    // LLM Score = 0, GenAI Says = Yes (conf > 0.90) → Score added
    if (llmScore === 0 && present === true && confidence > this.confidenceThreshold) {
      return {
        action: 'Score added',
        finalScore: 1,
        reason: 'GenAI confirmed trait presence with high confidence'
      };
    }

    // LLM Score = 0, GenAI Says = No → No change
    if (llmScore === 0 && present === false) {
      return {
        action: 'No change',
        finalScore: 0,
        reason: 'Both LLM and GenAI agree trait is not present'
      };
    }

    // Default: no change (should not reach here, but safety fallback)
    return {
      action: 'No change',
      finalScore: llmScore,
      reason: 'No significant change detected'
    };
  }
}

module.exports = new GenAiService();

