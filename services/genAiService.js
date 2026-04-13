const axios = require('axios');

/**
 * GenAI Service
 * Handles communication with the GenAI classification API
 */
class GenAiService {
  constructor() {
    this.apiUrl = 'https://data-science-dev-git-320866101884.us-central1.run.app/batch_classify';
    this.confidenceThreshold = 0.80; // Single threshold as requested
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
  /**
   * Bulk classify: send one reaction text, get verdicts for ALL traits in one call.
   * Payload: { version, text } (+ project_input/concept_input when version is context)
   */
  async classifyAll(text, version = 'basic', projectInput = '', conceptInput = '', reactionType = 'initial_reaction') {
    try {
      const payload = {
        text: text != null ? String(text).trim() : '',
        version: version === 'context' ? 'context' : 'basic',
        reaction_type: reactionType
      };
      if (payload.version === 'context') {
        payload.project_input = projectInput != null ? String(projectInput).trim() : '';
        payload.concept_input = conceptInput != null ? String(conceptInput).trim() : '';
      }
      const response = await axios.post(this.apiUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('GenAI bulk API Error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      return { success: false, error: error.message, data: null };
    }
  }

  /**
   * Pick one trait's verdict from a bulk classify response.
   * Supports multiple response shapes: { results: [...] }, array, or keyed object.
   */
  extractTraitFromBulk(bulkData, traitTitle) {
    if (!bulkData || traitTitle == null) return null;
    const titleLower = String(traitTitle).trim().toLowerCase();

    const normalize = (row) => {
      if (!row || row.present === undefined) return null;
      return { present: row.present, confidence: row.confidence, rationale: row.rationale, score: row.score };
    };

    const matchName = (x) => {
      const n = x.trait ?? x.trait_title ?? x.traitTitle ?? x.name ?? x.title;
      return n && String(n).trim().toLowerCase() === titleLower;
    };

    // Shape: { results: [...] } or { traits: [...] } etc.
    for (const key of ['results', 'traits', 'predictions', 'data', 'classifications']) {
      if (Array.isArray(bulkData[key])) {
        const hit = bulkData[key].find(matchName);
        if (hit) return normalize(hit);
      }
    }

    // Shape: top-level array
    if (Array.isArray(bulkData)) {
      const hit = bulkData.find(matchName);
      if (hit) return normalize(hit);
    }

    // Shape: keyed object { "Foresight": { present, confidence, ... } }
    if (typeof bulkData === 'object' && !Array.isArray(bulkData)) {
      for (const k of Object.keys(bulkData)) {
        if (String(k).trim().toLowerCase() === titleLower) {
          return normalize(bulkData[k]);
        }
      }
    }

    return null;
  }

  async classify(text, traitTitle, traitDefinition, traitExamples, version = 'basic', projectInput = '', conceptInput = '') {
    try {
      const payload = {
        text,
        trait: traitTitle,
        trait_definition: traitDefinition,
        trait_examples: traitExamples,
        version,
        project_input: projectInput,
        concept_input: conceptInput
      };
      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 300000 // 5 minutes timeout
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
   * Review is required if GenAI disagrees but confidence is below 80%
   */
  requiresReview(genAiResponse, llmScore) {
    if (!genAiResponse || genAiResponse.present === undefined) return false;

    const genAiScore = genAiResponse.present ? 1 : 0;
    const confValue = typeof genAiResponse.confidence === 'number'
      ? genAiResponse.confidence
      : parseFloat(genAiResponse.confidence);

    // If they disagree and confidence is low, it needs review
    return (genAiScore !== llmScore && confValue < this.confidenceThreshold);
  }

  /**
   * Determine the action based on LLM score and GenAI response
   * Simplified Logic based on Client Table:
   * - Agree: LLM Score == GenAI Score (Any confidence)
   * - Disagree: LLM Score != GenAI Score (Confidence >= 80%)
   * - Review: LLM Score != GenAI Score (Confidence < 80%)
   */
  determineAction(llmScore, genAiResponse) {
    if (!genAiResponse || genAiResponse.present === undefined) {
      return {
        action: 'Agree',
        finalScore: llmScore,
        reason: ''
      };
    }

    const { present, confidence, rationale } = genAiResponse;
    const genAiScore = present ? 1 : 0;
    const confValue = typeof confidence === 'number' ? confidence : parseFloat(confidence);

    // CASE 1: Agreement (Yes/Yes or No/No)
    if (llmScore === genAiScore) {
      return {
        action: 'Agree',
        finalScore: llmScore,
        reason: '' // Blank rationale for agreement as requested
      };
    }

    // CASE 2 & 3: Disagreement with High Confidence (>= 80%)
    if (confValue >= this.confidenceThreshold) {
      return {
        action: 'Disagree',
        finalScore: genAiScore, // Follow GenAI's recommendation
        reason: rationale || 'GenAI recommends a change based on analysis.'
      };
    }

    // CASE 4: Disagreement with Low Confidence (< 80%)
    return {
      action: 'Human review required',
      finalScore: llmScore, // Keep original score but flag for review
      reason: rationale || 'GenAI suggested a change but confidence is low.'
    };
  }
}

module.exports = new GenAiService();

