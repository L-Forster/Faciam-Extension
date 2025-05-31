class LLMAgent {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.systemPrompt = `You are a CSS customization agent. You will receive a combined prompt that may include global rules and specific local requests.
Global rules should be applied generally. Specific local requests override global rules if they conflict.
Prioritize the local request. If only global rules are provided, apply them. If only a local request is provided, apply that.

AVAILABLE TOOLS:
1. applyCSS(params: {css: string, description: string}) - Apply any custom CSS to the page. CSS should be a string.
2. modifyText(params: {selectors: array, transformType: string, instructions: string}) - Transform text content using AI (e.g., "Remove clickbait headlines", "Summarize this section"). 'selectors' is an array of CSS selectors. 'transformType' could be 'remove-clickbait', 'simplify', 'professionalize', 'summarize'. 'instructions' provides more details.
3. selectElements(params: {criteria: string, context: string}) - Intelligently select DOM elements based on criteria (e.g., "all images in the main article", "ad banners"). 'context' is a string describing the purpose.
4. generateCSS(params: {description: string, targetElements: array}) - Generate CSS based on natural language (e.g., "Make text larger and darker"). 'targetElements' is an optional array of CSS selectors for context.
5. hideElements(params: {criteria: string}) - Hide elements matching AI-determined criteria (e.g., "all pop-up modals").
6. transformLayout(params: {transformation: string, scope: string}) - Modify page layout structure (e.g., "create a two-column layout", "remove sidebars"). 'scope' might be 'main-content', 'full-page'.

Respond with JSON: { "tools": [{"function": "toolName", "params": {"paramName": "value"}}], "explanation": "What changes will be made" }`;
    }
    
    async processUserRequest(effectiveUserInput, tabId) {
        try {
            console.log('LLMAgent: Step 1: Analyzing page context...');
            const pageContext = await browser.tabs.sendMessage(tabId, {
                action: 'getPageContext'
            });
            
            console.log('LLMAgent: Step 2: Planning execution with AI using prompt:', effectiveUserInput);
            
            let llmResponseString = await this.callGeminiAPI(effectiveUserInput, pageContext);

            if (!llmResponseString || typeof llmResponseString !== 'string') {
                console.error('Invalid or empty response string received from LLM API. Type:', typeof llmResponseString, 'Value:', llmResponseString);
                throw new Error('Invalid or empty response string received from LLM API.');
            }

            // Remove Markdown code block delimiters if present
            let stringToParse = llmResponseString.trim();
            if (stringToParse.startsWith('```json') && stringToParse.endsWith('```')) {
                console.log('Detected Markdown JSON code block. Extracting content.');
                stringToParse = stringToParse.substring('```json'.length, stringToParse.length - '```'.length).trim();
            } else if (stringToParse.startsWith('```') && stringToParse.endsWith('```')) {
                // Handle case where it might just be ``` ... ``` without 'json'
                console.log('Detected generic Markdown code block. Extracting content.');
                stringToParse = stringToParse.substring('```'.length, stringToParse.length - '```'.length).trim();
            }
            
            const sanitizedResponseString = stringToParse.replace(/^\uFEFF/, '').replace(/\u200B/g, '');

            let instructions;
            try {
                instructions = JSON.parse(sanitizedResponseString);
            } catch (parseError) {
                console.error('Failed to parse (potentially extracted and) SANITIZED LLM response as JSON. Original string (first 200 chars):\n', llmResponseString.substring(0,200) + '...');
                console.error('String attempted for parsing (after potential Markdown extraction, first 200 chars):\n', sanitizedResponseString.substring(0,200) + '...');
                console.error('Full string that failed parsing was:\n', sanitizedResponseString);
                let charCodes = []; for(let i=0; i < Math.min(sanitizedResponseString.length, 500); i++) {charCodes.push(sanitizedResponseString.charCodeAt(i));}
                console.log('Character codes of the first 500 chars of string that failed parsing:', charCodes.join(', '));
                throw new Error('Failed to parse LLM response. Check background console for the full invalid JSON string and character codes.');
            }
            
            console.log('LLMAgent: Step 3: Executing customizations...');
            if (!instructions.tools || !Array.isArray(instructions.tools)) {
                console.error('Invalid AI response structure. Full response:\n', JSON.stringify(instructions, null, 2));
                throw new Error('Invalid response format from AI: tools array is missing or not an array.');
            }
            
            const executionResults = await this.executeTools(instructions.tools, tabId);
            const hasFailures = executionResults.some(r => !r.success);

            if (hasFailures) {
                const errors = executionResults.filter(r => !r.success).map(r => r.error || 'Unknown error during tool execution');
                const errorMessage = `One or more tools failed to execute: ${errors.join("; ")}`;
                console.error(errorMessage);
                return { success: false, error: errorMessage }; 
            }
            
            // Caching the successfully applied rule: send to content script
            try {
                const cachingPlan = instructions.tools.map(tool => ({
                    tool: tool.function,
                    parameters: tool.params
                }));
                const ruleData = {
                    command: effectiveUserInput,
                    executionPlan: { actions: cachingPlan },
                    results: executionResults,
                    timestamp: Date.now()
                };
                console.log('[LLMAgent] Sending cacheRule to content script:', ruleData);
                await browser.tabs.sendMessage(tabId, { action: 'cacheRule', rule: ruleData });
            } catch (cacheError) {
                console.error('[LLMAgent] Error sending cacheRule to content script:', cacheError);
            }
            
            return {
                success: true,
                explanation: instructions.explanation || 'Changes applied successfully!'
            };
            
        } catch (error) {
            console.error('LLM Agent error in processUserRequest:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    async callGeminiAPI(userInput, pageContext) {
        // Assumes this.apiKey is the Gemini API key
        if (!this.apiKey) {
            console.error("LLMAgent: Gemini API key is missing.");
            throw new Error('Gemini API key not configured in LLMAgent.');
        }

        const model = 'gemini-2.0-flash-lite'; // Or make this configurable if needed
        const fullUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

        const requestBody = {
            contents: [
                {
                    role: 'user',
                    parts: [{
                        text: `${this.systemPrompt}\n\nPage context: ${JSON.stringify(pageContext)}\n\nUser request: ${userInput}`
                    }]
                }
            ],
            // Optional: Add generationConfig (e.g., temperature, maxOutputTokens)
            // generationConfig: {
            // //   temperature: 0.3,
            // //   maxOutputTokens: 1000 
            //     thinking_budget: 0
            // }
        };

        try {
            const response = await fetch(fullUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();

            if (!response.ok) {
                const errorPayload = data || await response.text().catch(() => "Could not read error response body");
                console.error('Gemini API error (background.js):', response.status, JSON.stringify(errorPayload, null, 2));
                let detailedError = `Gemini API error: ${response.status}`;
                if (errorPayload.error && errorPayload.error.message) {
                    detailedError += ` - ${errorPayload.error.message}`;
                }
                throw new Error(detailedError);
            }
            
            if (!data || !data.candidates || data.candidates.length === 0 || 
                !data.candidates[0].content || !data.candidates[0].content.parts || 
                data.candidates[0].content.parts.length === 0 || !data.candidates[0].content.parts[0].text) {
                console.error('Unexpected Gemini API response format (background.js). Full data:', JSON.stringify(data, null, 2));
                throw new Error('Unexpected response format from Gemini API (background.js).');
            }
            
            console.log('Gemini API call successful (background.js). Finish reason:', data.candidates[0].finishReason);
            // Gemini might also have finishReason: "MAX_TOKENS", "SAFETY", etc.
            if (data.candidates[0].finishReason === 'MAX_TOKENS') {
                console.warn('Gemini response was truncated due to maxOutputTokens limit (background.js).');
            }
            
            return data.candidates[0].content.parts[0].text;
        } catch (error) {
            console.error('Error in callGeminiAPI function (background.js):', error);
            if (error instanceof Error) {
                throw error;
            } else {
                throw new Error('Failed to call Gemini API (background.js): ' + JSON.stringify(error));
            }
        }
    }
    
    async executeTools(tools, tabId) {
        const results = [];
        for (const tool of tools) {
            // Preview parameters for logging
            let paramPreview;
            if (typeof tool.params === 'string') {
                paramPreview = tool.params.length > 50 ? tool.params.substring(0,50) + '...' : tool.params;
            } else if (typeof tool.params === 'object' && tool.params !== null) {
                try {
                    paramPreview = JSON.stringify(tool.params);
                } catch (e) {
                    paramPreview = String(tool.params);
                }
            } else {
                paramPreview = String(tool.params); // Fallback for other types or null
            }
            console.log(`Executing tool: ${tool.function}`, paramPreview);
            try {
                const response = await browser.tabs.sendMessage(tabId, {
                    action: 'executeTool',
                    tool: tool.function,
                    params: tool.params
                });
                console.log(`Background.js: Raw response from content script for tool ${tool.function}:`, response);
                if (response && response.success) {
                    results.push({ tool: tool.function, success: true, result: response.result });
                } else {
                    results.push({ tool: tool.function, success: false, error: response && response.error || 'Tool execution failed without specific error message.' });
                }
            } catch (e) {
                console.error(`Error sending message to content script for tool ${tool.function}:`, e);
                results.push({ tool: tool.function, success: false, error: e.message || 'Communication error with content script.' });
            }
        }
        return results;
    }
}

class BackgroundController {
    constructor() {
        this.setupMessageListener();
    }

    async processCustomizationLogic(primaryPrompt, apiKeyFromPopup, tabId) {
        try {
            let apiKeyToUse = apiKeyFromPopup;
            if (!apiKeyToUse) {
                const storedKey = await browser.storage.local.get('apiKey');
                if (storedKey.apiKey) {
                    apiKeyToUse = storedKey.apiKey;
                } else {
                    console.error('API Key Error: No API key provided directly or found in storage for processCustomizationLogic');
                    return { success: false, error: 'API Key not configured.' };
                }
            }

            // Try to send a ping to content script. If it fails, inject scripts.
            try {
                await browser.tabs.sendMessage(tabId, { action: 'ping' });
            } catch (e) {
                console.log('Ping failed, injecting scripts into tab:', tabId);
                await browser.tabs.executeScript(tabId, { file: 'browser-polyfill.js' });
                await browser.tabs.executeScript(tabId, { file: 'content.js' });
                await browser.tabs.insertCSS(tabId, { file: 'content.css' });
                await new Promise(resolve => setTimeout(resolve, 200));
                // Force re-application of cached rules in content script
                await browser.tabs.executeScript(tabId, {
                    code: `
                    try {
                        if (window.aiWebCustomizationAgentInstance && typeof window.aiWebCustomizationAgentInstance.applyExistingRules === 'function') {
                            console.log('[Background] Triggering applyExistingRules after injection.');
                            window.aiWebCustomizationAgentInstance.applyExistingRules();
                        }
                    } catch (e) {
                        console.error('[Background] Error triggering applyExistingRules:', e);
                    }
                    `
                });
            }

            await browser.tabs.sendMessage(tabId, {
                action: 'setAIConfig',
                config: { apiKey: apiKeyToUse }
            });

            const storedData = await browser.storage.local.get('globalPromptText');
            const globalPromptFromStorage = (storedData.globalPromptText || "").trim();
            const currentPrimaryPrompt = (primaryPrompt || "").trim();

            let finalPromptForLLM = "";

            if (currentPrimaryPrompt && currentPrimaryPrompt !== globalPromptFromStorage) {
                // primaryPrompt is a distinct local prompt. Combine with global if global exists.
                finalPromptForLLM = globalPromptFromStorage ? `${globalPromptFromStorage}\n\n${currentPrimaryPrompt}` : currentPrimaryPrompt;
            } else {
                // primaryPrompt is empty, or it's the same as the global prompt (e.g., auto-apply case)
                // In these scenarios, the effective prompt is the global prompt from storage.
                finalPromptForLLM = globalPromptFromStorage;
            }

            if (!finalPromptForLLM || !finalPromptForLLM.trim()) {
                console.log('Background: No effective prompt (local or global) to process. Skipping.');
                return { success: true, explanation: 'No changes applied as no prompt was provided.' };
            }
            
            console.log('Background: Processing with final prompt for LLM:', finalPromptForLLM);
            const agent = new LLMAgent(apiKeyToUse);
            const result = await agent.processUserRequest(finalPromptForLLM, tabId);
            return result;
        } catch (error) {
            console.error('Background processCustomizationLogic error:', error);
            return { 
                success: false, 
                error: error.message || 'Unknown error occurred while processing customization logic'
            };
        }
    }
    
    setupMessageListener() {
        browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
            if (message.action === 'getApiKeyStatus') {
                const result = await browser.storage.local.get('apiKey');
                const keyExists = !!result.apiKey;
                console.log('Background: API key status check -', keyExists ? 'Key exists in storage' : 'No key in storage');
                sendResponse({ apiKeyIsSet: keyExists });
                return true; // Keep channel open
            }

            if (message.action === 'processCustomization') {
                try {
                    const result = await this.processCustomizationLogic(message.userInput, message.apiKey, message.tabId);
                    
                    if (typeof result === 'object' && result !== null && ('success' in result)) {
                        sendResponse(result);
                    } else {
                        console.error('[Background] Unexpected result format before sendResponse. Expected object with \'success\' property. Actual result type:', typeof result, 'Actual result:', JSON.stringify(result));
                        sendResponse({ success: false, error: 'Background script encountered an internal data processing error.' });
                    }
                } catch (e) {
                    console.error('[Background] Critical error during processCustomization message handling:', e);
                    try {
                        sendResponse({ success: false, error: `Background script critical error: ${e.message || String(e)}` });
                    } catch (sendError) {
                        console.error('[Background] Failed to send critical error response after an exception:', sendError);
                    }
                }
                return true; // Keep channel open for async response
            }
            
            // Default return true for other unhandled messages if they might be async
            // Consider making this more specific if new message types are added
            if (message && message.action) {
                 console.log('[Background] Unhandled message action:', message.action);
            } else {
                 console.log('[Background] Unhandled message with no action property:', message);
            }
            return true; 
        });
    }
}

const bgController = new BackgroundController();

// Auto-apply saved customization when a page finishes loading
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && /^https?:/.test(tab.url)) {
        // Ensure content script is loaded in this tab before any further logic
        try {
            await browser.tabs.sendMessage(tabId, { action: 'ping' });
        } catch (injectError) {
            console.log('onUpdated: ping to content script failed, injecting content scripts for tab', tabId);
            // Order matters: polyfill, then content script, then CSS
            await browser.tabs.executeScript(tabId, { file: 'browser-polyfill.js' });
            await browser.tabs.executeScript(tabId, { file: 'content.js' });
            await browser.tabs.insertCSS(tabId, { file: 'content.css' });
            // Brief pause to allow the content script to initialize
            await new Promise(resolve => setTimeout(resolve, 200));
            // Force re-application of cached rules in content script
            await browser.tabs.executeScript(tabId, {
                code: `
                try {
                    if (window.aiWebCustomizationAgentInstance && typeof window.aiWebCustomizationAgentInstance.applyExistingRules === 'function') {
                        console.log('[Background] Triggering applyExistingRules after injection.');
                        window.aiWebCustomizationAgentInstance.applyExistingRules();
                    }
                } catch (e) {
                    console.error('[Background] Error triggering applyExistingRules:', e);
                }
                `
            });
        }
        try {
            const storedData = await browser.storage.local.get(['globalPromptText']); // Only fetch globalPromptText
            const globalPrompt = storedData.globalPromptText;

            if (globalPrompt && globalPrompt.trim()) {
                console.log(`Auto-applying GLOBAL customization for tab ${tabId}. Using global prompt:`, globalPrompt.trim());
                // Pass the globalPrompt directly as the 'primaryPrompt'.
                // apiKeyFromPopup is null, so processCustomizationLogic will use the stored key.
                const response = await bgController.processCustomizationLogic(globalPrompt.trim(), null, tabId);
                console.log('Auto-apply response for tab', tabId, ':', response);
            } else {
                console.log(`No global prompt set for tab ${tabId}. Skipping auto-apply.`);
            }
        } catch (err) {
            console.error('Error in auto-apply onUpdated listener for tab', tabId, ':', err);
        }
    }
});