// Popup script
document.addEventListener('DOMContentLoaded', function() {
  const summarizeBtn = document.getElementById('summarizeBtn');
  const loadingSpinner = document.getElementById('loadingSpinner');
  const summaryDiv = document.getElementById('summary');

  // Hardcoded API key - replace with your actual API key from Hugging Face
  const API_KEY = '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';

  summarizeBtn.addEventListener('click', async () => {
    // Show loading state
    loadingSpinner.classList.remove('hidden');
    summaryDiv.classList.add('hidden');
    summarizeBtn.disabled = true;

    try {
      // Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // Execute content script to get page content
      const [{result}] = await chrome.scripting.executeScript({
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

      // Get summary from Hugging Face API
      const response = await fetch('https://api-inference.huggingface.co/models/facebook/bart-large-cnn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          inputs: result.substring(0, 1000), // Limit input size
          parameters: {
            max_length: 150,
            min_length: 50,
          }
        })
      });

      const data = await response.json();
      
      // Check if the API returned an error
      if (data.error) {
        throw new Error(data.error);
      }

      // Display summary - handle both possible response formats
      const summaryText = Array.isArray(data) ? data[0].summary_text : data.summary_text;
      if (!summaryText) {
        throw new Error('No summary generated');
      }
      
      summaryDiv.textContent = summaryText;
      summaryDiv.classList.remove('hidden');
    } catch (error) {
      console.error('Summarization error:', error);
      summaryDiv.textContent = 'Error generating summary: ' + error.message;
      summaryDiv.classList.remove('hidden');
    } finally {
      // Hide loading state
      loadingSpinner.classList.add('hidden');
      summarizeBtn.disabled = false;
    }
  });
});
