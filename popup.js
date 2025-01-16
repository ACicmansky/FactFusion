// Popup script
import config from './config.js';

document.addEventListener('DOMContentLoaded', async function () {
  const loadingSpinner = document.getElementById('loadingSpinner');
  const summaryDiv = document.getElementById('summary');
  const clearCacheButton = document.getElementById('clearCache');

  // Function to clear all cached responses
  async function clearCache() {
    try {
      await chrome.storage.local.clear();
      console.log('Cache cleared successfully');
      // Optional: You could add a visual feedback here
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }

  // Add click event listener for clear cache button
  clearCacheButton.addEventListener('click', clearCache);

  // Function to delay execution
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Function to generate a hash for the content
  function generateHash(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  // Function to get cached response
  async function getCachedResponse(content) {
    const hash = generateHash(content);
    const cached = await chrome.storage.local.get(hash);
    return cached[hash];
  }

  // Function to cache response
  async function cacheResponse(content, response) {
    const hash = generateHash(content);
    await chrome.storage.local.set({ [hash]: response });
  }

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
            temperature: 0,
            top_p: 1,
            random_seed: 42
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

  // Automatically process when popup opens
  try {
    // Show loading state
    loadingSpinner.classList.remove('hidden');
    summaryDiv.classList.add('hidden');

    // Query active tab
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
    Separate each statement in {Output} with <br><br> for empty lines. Print language that is used in {Text}.
    Print {Output} directly without headings or extra formatting
    {Text}=\n\n${result}`;

    // Check cache first
    const cachedResponse = await getCachedResponse(result);
    let data;
    
    if (cachedResponse) {
      data = cachedResponse;
      console.log('Using cached response');
    } else {
      data = await queryModel(prompt);
      if (data) {
        // Cache the successful response
        await cacheResponse(result, data);
      }
    }

    // Check if the API returned an error
    if (!data) {
      throw new Error('No key information extracted');
    }

    // Display the formatted text
    const summaryContent = document.querySelector('.summary-content');
    summaryContent.innerHTML = data;
    loadingSpinner.classList.add('hidden');
    summaryDiv.classList.remove('hidden');
  } catch (error) {
    console.error('Extraction error:', error);
    loadingSpinner.classList.add('hidden');
    summaryDiv.classList.remove('hidden');
    document.querySelector('.summary-content').innerHTML = 'Error extracting information: ' + error.message;
  }
});
