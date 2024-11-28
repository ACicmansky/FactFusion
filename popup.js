// Popup script
import config from './config.js';

document.addEventListener('DOMContentLoaded', function () {
  const summarizeBtn = document.getElementById('summarizeBtn');
  const loadingSpinner = document.getElementById('loadingSpinner');
  const summaryDiv = document.getElementById('summary');

  // Function to delay execution
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Function to query the model with retries
  async function queryModel(inputs, maxRetries = 3, initialDelay = 1000) {
    let lastError;
    let retryDelay = initialDelay;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch('https://api-inference.huggingface.co/models/google/flan-t5-large', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.API_KEY}`
          },
          body: JSON.stringify({
            inputs,
            parameters: {
              max_length: 1000,
              temperature: 0.3,
              top_p: 0.95,
              do_sample: true,
              num_return_sequences: 1
            }
          })
        });

        const data = await response.json();

        // Check if model is loading
        if (data.error && data.error.includes('loading')) {
          console.log(`Model is loading, attempt ${i + 1} of ${maxRetries}. Waiting ${retryDelay}ms...`);
          await delay(retryDelay);
          retryDelay *= 2; // Exponential backoff
          continue;
        }

        return data;
      } catch (error) {
        lastError = error;
        console.error(`Attempt ${i + 1} failed:`, error);
        await delay(retryDelay);
        retryDelay *= 2; // Exponential backoff
      }
    }

    throw new Error(lastError?.message || 'Failed to get response after multiple retries');
  }

  summarizeBtn.addEventListener('click', async () => {
    // Show loading state
    loadingSpinner.classList.remove('hidden');
    summaryDiv.classList.add('hidden');
    summarizeBtn.disabled = true;

    try {
      // Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Execute content script to get page content
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          function getTextContent(element) {
            return element.textContent.trim().replace(/\s+/g, ' ');
          }

          function getContentScore(element) {
            const text = getTextContent(element);
            const wordCount = text.split(/\s+/).length;

            // Negative indicators
            const hasNegativeClass = /(comment|footer|sidebar|nav|menu|header|banner|copyright|social)/i;
            const hasNegativeId = /(comment|footer|sidebar|nav|menu|header|banner|copyright|social)/i;

            let score = wordCount;

            // Reduce score for elements likely to be non-main content
            if (hasNegativeClass.test(element.className) || hasNegativeId.test(element.id)) {
              score *= 0.3;
            }

            // Boost score for elements likely to be main content
            if (/(content|article|post|story|text|body)/i.test(element.className) ||
              /(content|article|post|story|text|body)/i.test(element.id)) {
              score *= 1.5;
            }

            // Penalize if too many links
            const links = element.getElementsByTagName('a');
            if (links.length > 0) {
              const textLength = text.length;
              const linkLength = Array.from(links).reduce((acc, link) => acc + link.textContent.length, 0);
              if (linkLength / textLength > 0.3) {
                score *= 0.7;
              }
            }

            return score;
          }

          // Priority-based content extraction
          const contentSelectors = [
            'article',
            '[role="main"]',
            'main',
            '.main-content',
            '#main-content',
            '.post-content',
            '.article-content',
            '.content',
            '#content',
            '.entry-content',
            '.post',
            '.article'
          ];

          // Try priority selectors first
          for (const selector of contentSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const content = getTextContent(element);
              if (content.length > 150) { // Minimum content length threshold
                return content;
              }
            }
          }

          // If no priority selector matches, analyze all potential content blocks
          const contentBlocks = document.querySelectorAll('div, section, article');
          let bestBlock = null;
          let bestScore = 0;

          contentBlocks.forEach(block => {
            const score = getContentScore(block);
            if (score > bestScore) {
              bestScore = score;
              bestBlock = block;
            }
          });

          // Fallback to body if no good content block found
          return bestBlock ? getTextContent(bestBlock) : document.body.innerText;
        }
      });

      if (!result || result.trim().length === 0) {
        throw new Error('No content found on the page');
      }

      // Extract key information using Flan-T5 model with retry mechanism
      const prompt = `Extract the most important information from the text, including key facts, critical details (names, dates, figures), and relevance, and present it concisely in a structured format: Summary, Key Points, and Significance. Text:\n\n${result.substring(0, 3000)}`;

      const data = await queryModel(prompt);

      // Check if the API returned an error
      if (data.error) {
        throw new Error(data.error);
      }

      // Format and display the key points
      let mainPoints = Array.isArray(data) ? data[0].generated_text : data.generated_text;

      if (!mainPoints) {
        throw new Error('No key information extracted');
      }

      // Display the formatted text
      summaryDiv.innerHTML = mainPoints;
      summaryDiv.classList.remove('hidden');
    } catch (error) {
      console.error('Extraction error:', error);
      summaryDiv.textContent = 'Error extracting information: ' + error.message;
      summaryDiv.classList.remove('hidden');
    } finally {
      // Hide loading state
      loadingSpinner.classList.add('hidden');
      summarizeBtn.disabled = false;
    }
  });
});
