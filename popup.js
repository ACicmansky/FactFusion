// Popup script
import config from './config.js';

document.addEventListener('DOMContentLoaded', function () {
  const summarizeBtn = document.getElementById('summarizeBtn');
  const loadingSpinner = document.getElementById('loadingSpinner');
  const summaryDiv = document.getElementById('summary');

  // Function to delay execution
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Function to query the model with retries
  async function queryModel(inputs) {
    const maxRetries = 5;
    const retryDelay = 1000; // 1 second

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.API_KEY}`
          },
          body: JSON.stringify({
            model: 'mistral-large-latest',
            messages: [{ role: 'user', content: inputs }],
            max_tokens: 1000,
            temperature: 0.3,
            top_p: 0.95
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error?.message || 'API request failed');
        }

        return data.choices[0].message.content.trim();
      } catch (error) {
        console.error(`Attempt ${i + 1} failed:`, error);
        if (i === maxRetries - 1) throw error;
        await delay(retryDelay);
      }
    }
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
      let [{ result }] = await chrome.scripting.executeScript({
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

      result = result.length > 4000 ? result.substring(0, 4000) : result;
      const prompt = `Analyze {Text} based on your knowledge base and training data, find false statements or unsupported claims, and for each, prepare {Output}: one or two sentences explaining inconsistencies.
      Separate each statement in {Output} with <br><br> for empty lines.
      Print {Output} directly without headings or extra formatting
      {Text}=\n\n${result}`;

      const data = await queryModel(prompt);

      // Check if the API returned an error
      if (!data) {
        throw new Error('No key information extracted');
      }

      // Display the formatted text
      summaryDiv.innerHTML = data;
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
