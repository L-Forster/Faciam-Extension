// Top-level log to verify content script injection
console.log('[ContentJS] content.js injected and running');

class AIWebCustomizationAgent {
    constructor() {
        console.log('[ContentJS] Constructor called. Initializing...');
        this.appliedStyles = new Set();
        this.appliedRules = new Map(); // Not heavily used, but kept for potential future use
        this.contentObserver = null;
        this.domainRules = new Map();
        this.aiConfig = {
            apiKey: null,
            endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
            model: 'gemini-2.5-flash-lite'
        };
        this.tools = new Map();
        this.pageContext = null;
        this.isInitialized = false;
        this.reapplyTimeout = null;
        this.contextCacheTimeout = null;
        this.contextCacheTime = 0;

        this.setupTools();
        this.setupMessageListener();
        this.createStyleElement();
        this.initialize();
    }

    async initialize() {
        if (this.isInitialized) return;
        try {
            await this.loadDomainRules();
            const domain = this.getDomainKey();
            console.log(`[Initialize] After loadDomainRules. Domain: ${domain}. this.domainRules map size: ${this.domainRules.size}`);
            if (this.domainRules.has(domain)) {
                console.log(`[Initialize] Rules found for current domain '${domain}'. Count: ${this.domainRules.get(domain).length}`);
                console.log(`[Initialize] Rules content for '${domain}' (first rule preview if exists):`, this.domainRules.get(domain).length > 0 ? JSON.stringify(this.domainRules.get(domain)[0]).substring(0, 300) + '...' : 'No rules');
            } else {
                console.log(`[Initialize] No rules entry found for current domain '${domain}' in this.domainRules map.`);
            }

            if (this.domainRules.has(domain) && this.domainRules.get(domain).length > 0) {
                console.log('Applying existing domain rules...');
                await this.applyExistingRules();
            }
            this.initializeContentObserver();
            this.isInitialized = true;
            console.log('AIWebCustomizationAgent initialized.');
        } catch (error) {
            console.error('Failed to initialize AI agent:', error);
        }
    }

    setupTools() {
        this.tools.set('applyCSS', {
            description: 'Apply custom CSS rules to modify page styling. Use for direct styling changes.',
            parameters: { css: 'string', description: 'string' },
            // This will now correctly return the object from the modified applyCustomCSS
            execute: async (params) => this.applyCustomCSS(params.css, params.description)
        });

        this.tools.set('modifyText', {
            description: 'Transform text content of specified elements using AI (e.g., summarize, de-clickbait, simplify). This is applied dynamically on each load.',
            parameters: { selectors: 'array', transformType: 'string', instructions: 'string' },
            execute: async (params) => this.aiModifyText(params.selectors, params.transformType, params.instructions)
        });

        this.tools.set('selectElements', {
            description: 'Intelligently select DOM elements based on natural language criteria. Usually a sub-step for other tools.',
            parameters: { criteria: 'string', context: 'string' },
            execute: async (params) => this.aiSelectElements(params.criteria, params.context)
        });

        this.tools.set('generateCSS', {
            description: 'Generate CSS based on a natural language description of desired style changes. Output will be cached for future applications.',
            parameters: { description: 'string', targetElements: 'array' /* optional array of selectors to provide context */ },
            execute: async (params) => {
                const css = await this.aiGenerateCSS(params.description, params.targetElements);
                if (css) {
                    // Apply immediately for the current session
                    this.applyCustomCSS(css, `Generated CSS: ${params.description}`);
                    // Return the CSS so it can be cached by executeNaturalLanguageCommand
                    return { css, description: `Generated CSS: ${params.description}`, appliedNow: true };
                }
                return { css: null, description: 'No CSS generated or applied.', appliedNow: false };
            }
        });

        this.tools.set('hideElements', {
            description: 'Hide elements matching AI-determined criteria or specific selectors. Generated hiding CSS will be cached.',
            parameters: { criteria: 'string' /* or selectors: 'array' */},
            execute: async (params) => {
                let elementsToHideSelectors;
                let generatedCssForHiding = '';
                // Use the criteria or description from params for the final CSS comment
                const baseDescription = params.criteria || (params.selectors ? 'selected elements' : 'unspecified elements');
                const finalDescription = `Hide: ${baseDescription}`;


                if (params.selectors && Array.isArray(params.selectors)) {
                    elementsToHideSelectors = params.selectors;
                } else if (params.criteria) {
                    elementsToHideSelectors = await this.aiSelectElements(params.criteria, 'hiding elements');
                } else {
                    throw new Error("Either 'criteria' or 'selectors' must be provided for hideElements.");
                }

                if (!elementsToHideSelectors || elementsToHideSelectors.length === 0) {
                    return { hiddenSelectors: [], css: null, description: finalDescription, message: "No elements selected for hiding." };
                }

                generatedCssForHiding = elementsToHideSelectors.map(selector =>
                    `${selector} { display: none !important; }`
                ).join('\n');

                this.applyCustomCSS(generatedCssForHiding, finalDescription);
                // Return the generated CSS and selectors for potential caching
                return { hiddenSelectors: elementsToHideSelectors, css: generatedCssForHiding, description: finalDescription };
            }
        });

        this.tools.set('transformLayout', {
            description: 'Modify page layout structure using generated CSS. Output will be cached for future applications.',
            parameters: { transformation: 'string', scope: 'string' /* e.g., "main content", "article" */ },
            execute: async (params) => {
                const css = await this.aiTransformLayout(params.transformation, params.scope);
                const description = `Layout: ${params.transformation}`;
                if (css) {
                    this.applyCustomCSS(css, description);
                    return { css, applied: true, description: description };
                }
                return { css: null, applied: false, description: description };
            }
        });

         this.tools.set('summarizeContent', {
            description: 'Summarize the main content of the page or specific elements. This is applied dynamically on each load.',
            parameters: { selectors: 'array' /* optional, defaults to main page content */, length: 'string' /* e.g., "short", "medium", "detailed" */ },
            execute: async (params) => this.aiSummarizeContent(params.selectors, params.length)
        });
    }

    async aiSummarizeContent(selectors, length = "medium") {
        let textToSummarize = "";
        if (selectors && selectors.length > 0) {
            selectors.forEach(selector => {
                try {
                    document.querySelectorAll(selector).forEach(el => {
                        textToSummarize += el.textContent.trim() + "\n\n";
                    });
                } catch (e) { console.warn(`Invalid selector in aiSummarizeContent: ${selector}`); }
            });
        } else {
            // Fallback to a general page content extraction if no selectors
            const mainContentSelector = this.findMainContentSelector();
            const mainElement = document.querySelector(mainContentSelector);
            if (mainElement) {
                textToSummarize = mainElement.textContent.trim();
            } else {
                 this.extractParagraphs().forEach(p => textToSummarize += p.text + "\n\n");
            }
        }

        if (textToSummarize.length < 100) { // Arbitrary threshold
            return { summary: "Not enough content to summarize or content not found.", originalLength: textToSummarize.length };
        }

        // Truncate if too long to avoid excessive API costs/time
        const MAX_TEXT_LENGTH = 15000; // Roughly 4k tokens
        if (textToSummarize.length > MAX_TEXT_LENGTH) {
            textToSummarize = textToSummarize.substring(0, MAX_TEXT_LENGTH);
        }

        const prompt = `
Summarize the following text to a ${length} length.
Focus on the key information and main points.
If the text appears to be a list of items or an article, summarize accordingly.

Text:
"""
${textToSummarize}
"""

Return only the summary.
`;
        try {
            const summary = await this.callAI(prompt);
            return { summary, originalLength: textToSummarize.length, summarizedLength: summary.length };
        } catch (error) {
            console.error("Error during AI summarization:", error);
            throw new Error(`AI summarization failed: ${error.message}`);
        }
    }

    createStyleElement() {
        this.styleElement = document.createElement('style');
        this.styleElement.id = 'ai-web-customizer-styles';
        document.head.appendChild(this.styleElement);
    }

    setupMessageListener() {
        // Ensure 'browser' is defined (standard for WebExtensions)
        if (typeof browser === "undefined" || !browser.runtime || !browser.runtime.onMessage) {
            console.warn("Browser runtime or onMessage API not available. Message listener not set up.");
            return;
        }

        browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
            // console.log('Content.js: Received message:', message);
            switch (message.action) {
                case 'ping':
                    sendResponse({ ack: true, initialized: this.isInitialized });
                    return false; // Synchronous response
                case 'getPageContext':
                    this.getCachedPageContext()
                        .then(context => sendResponse(context))
                        .catch(error => {
                            console.error("Error in getPageContext:", error);
                            sendResponse({ error: error.message });
                        });
                    return true; // Keep message channel open for async response
                case 'resetCustomizations':
                    this.resetAll()
                        .then(() => sendResponse({ success: true }))
                        .catch(error => {
                            console.error("Error in resetCustomizations:", error);
                            sendResponse({ success: false, error: error.message });
                        });
                    return true; // Async
                case 'setAIConfig':
                    if (message.config && message.config.apiKey) {
                        this.aiConfig.apiKey = message.config.apiKey;
                        console.log('Content.js: Received and updated API key.');
                        sendResponse({ success: true });
                    } else {
                        console.warn('Content.js: setAIConfig message received without apiKey in config');
                        sendResponse({ success: false, error: 'API key missing in config.' });
                    }
                    return false; // Synchronous
                case 'executeTool': // Direct tool execution
                    this.executeTool(message.tool, message.params)
                        .then(result => {
                            sendResponse({ success: true, result });
                        })
                        .catch(error => {
                            console.error(`Content.js: Error executing tool ${message.tool}:`, error);
                            sendResponse({ success: false, error: error.message });
                        });
                    return true; // Async
                case 'executeNaturalLanguageCommand':
                    this.executeNaturalLanguageCommand(message.command)
                        .then(result => {
                            sendResponse({ success: true, result });
                        })
                        .catch(error => {
                            console.error('Content.js: Error executing natural language command:', error);
                            sendResponse({ success: false, error: error.message });
                        });
                    return true; // Async
                case 'cacheRule':
                    (async () => {
                        try {
                            console.log('[ContentJS] cacheRule received, saving rule for domain:', this.getDomainKey());
                            await this.saveDomainRule(message.rule);
                            console.log('[ContentJS] Rule successfully saved:', message.rule);
                            sendResponse({ success: true });
                        } catch (e) {
                            console.error('[ContentJS] Error saving cached rule:', e);
                            sendResponse({ success: false, error: e.message });
                        }
                    })();
                    return true; // Async response
                default:
                    console.warn(`Content.js: Unknown message action: ${message.action}`);
                    sendResponse({ success: false, error: `Unknown action: ${message.action}` });
                    return false; // Synchronous for unknown actions
            }
        });
    }

    async executeNaturalLanguageCommand(userCommand) {
        if (!this.aiConfig.apiKey) {
            console.error('AI API key not configured');
            throw new Error('AI API key not configured. Please set it in the extension options.');
        }
        console.log(`Executing NLC: "${userCommand}"`);

        const pageContext = await this.getCachedPageContext();
        const initialExecutionPlan = await this.planExecution(userCommand, pageContext); // This is the plan from the AI

        if (!initialExecutionPlan || !initialExecutionPlan.actions || initialExecutionPlan.actions.length === 0) {
            console.warn('Execution plan resulted in no actions.');
            return { executionPlan: initialExecutionPlan, results: [], message: "AI could not determine any actions for this command." };
        }
        console.log('Initial Execution Plan:', JSON.stringify(initialExecutionPlan, null, 2));

        // Create an array of promises, one for each tool execution from the initial plan
        const toolExecutionPromises = initialExecutionPlan.actions.map(action => {
            console.log(`Preparing tool: ${action.tool} with params:`, action.parameters);
            return this.executeTool(action.tool, action.parameters)
                       .catch(err => Promise.reject({error: err, tool: action.tool, params: action.parameters}));
        });

        const settledOutcomes = await Promise.allSettled(toolExecutionPromises);
        console.log('Settled Outcomes from initial execution:', settledOutcomes);

        const finalResultsOfThisSession = [];
        // Create a deep copy of the initial plan. This copy will be modified for storage if necessary.
        const planForStorage = JSON.parse(JSON.stringify(initialExecutionPlan));

        settledOutcomes.forEach((outcome, index) => {
            const originalAction = initialExecutionPlan.actions[index]; // Action from the AI's original plan
            let currentSessionResult = { tool: originalAction.tool, success: false, params: originalAction.parameters };

            if (outcome.status === 'fulfilled') {
                console.log(`Tool ${originalAction.tool} (from initial plan) succeeded.`);
                currentSessionResult.success = true;
                currentSessionResult.result = outcome.value; // The actual result returned by the tool's execute method

                // --- START CACHING TRANSFORMATION FOR THE PLAN TO BE STORED ---
                const toolNameToTransform = originalAction.tool;
                const successfulToolOutput = outcome.value; // e.g., { css: "...", description: "..." }

                console.log(`[Cache Pre-Check] Tool ${originalAction.tool} output for caching. CSS type: ${typeof successfulToolOutput.css}, CSS value (preview): ${(successfulToolOutput.css || "").substring(0,70)}... Description: ${successfulToolOutput.description ? successfulToolOutput.description.substring(0,70) + '...': 'N/A'}`);

                // Check if the tool's output contains CSS, indicating it's a candidate for caching as 'applyCSS'
                if (successfulToolOutput && typeof successfulToolOutput.css === 'string') {
                    // Use the description from the tool's output if available, otherwise fallback
                    let descriptionForCachedCSS = successfulToolOutput.description ||
                                                  originalAction.parameters.description ||  // from generateCSS params
                                                  originalAction.parameters.transformation || // from transformLayout params
                                                  (originalAction.parameters.criteria ? `Hide: ${originalAction.parameters.criteria}` : `Cached CSS for ${toolNameToTransform}`);


                    // Transform the action in `planForStorage`
                    planForStorage.actions[index] = {
                        tool: 'applyCSS',
                        parameters: {
                            css: successfulToolOutput.css,
                            description: descriptionForCachedCSS
                        },
                        // Add reasoning to the stored plan action for clarity if inspected later
                        reasoning: `Rule cached: Original tool was '${toolNameToTransform}'. Now applying cached CSS for '${descriptionForCachedCSS}'.`
                    };
                    console.log(`Transforming action '${toolNameToTransform}' to 'applyCSS' for storage. Description: '${descriptionForCachedCSS}'`);
                    console.log(`[Cache Detail] Action at index ${index} in planForStorage TRANSFORMED to:`, JSON.stringify(planForStorage.actions[index]));
                } else {
                     console.log(`[Cache Detail] Action at index ${index} in planForStorage RETAINED as original (no CSS string output for caching):`, JSON.stringify(planForStorage.actions[index]));
                }
                // Tools like 'modifyText', 'summarizeContent', 'selectElements', or direct 'applyCSS'
                // don't need this transformation. Their original planned action is suitable for re-application.
                // So, `planForStorage.actions[index]` remains as it was in `initialExecutionPlan.actions[index]` for these.
                // --- END CACHING TRANSFORMATION FOR THE PLAN TO BE STORED ---

            } else { // Tool execution failed
                const errorDetails = outcome.reason.error || outcome.reason;
                console.error(`Tool ${originalAction.tool} (from initial plan) failed:`, errorDetails.message || errorDetails);
                currentSessionResult.error = errorDetails.message || String(errorDetails);
                // If a generation step failed, planForStorage.actions[index] will still contain the original generative action.
                // This means on next load, it will try to generate again.
            }
            finalResultsOfThisSession.push(currentSessionResult);
        });

        if (finalResultsOfThisSession.some(r => r.success) && this.shouldPersistRule(userCommand)) {
            console.log('Command indicates persistence. Saving domain rule with potentially transformed plan for storage.');
            console.log('[Cache Save] Final planForStorage being sent to saveDomainRule (preview):', JSON.stringify(planForStorage, null, 2).substring(0, 500) + "...");
            await this.saveDomainRule({
                command: userCommand,
                executionPlan: planForStorage,         // Save the plan optimized for future runs (with cached CSS)
                results: finalResultsOfThisSession,    // Save the outcomes of *this specific* execution session
                timestamp: Date.now()
            });
        }

        // Return the plan that was *actually executed* in this session (initial plan)
        // and the results of *this session's* tool executions.
        return { executionPlan: initialExecutionPlan, results: finalResultsOfThisSession };
    }

    shouldPersistRule(userCommand) {
        const persistKeywords = [
            'always', 'permanently', 'every time', 'on this site',
            'remember', 'save', 'keep', 'default', 'for this website'
        ];
        const command = userCommand.toLowerCase();
        return persistKeywords.some(keyword => command.includes(keyword));
    }

    async planExecution(userCommand, pageContext) {
        const toolDescriptions = Array.from(this.tools.entries()).map(([name, tool]) =>
            `- ${name}: ${tool.description}\n  Parameters: ${JSON.stringify(tool.parameters)}`
        ).join('\n');

        const prompt = `
You are an AI agent that customizes web pages based on user commands.
Your goal is to create an execution plan consisting of one or more actions.
Each action involves selecting an appropriate tool and its parameters.

User Command: "${userCommand}"

Page Context:
- URL: ${pageContext.url}
- Title: ${pageContext.title}
- Main Content Structure: ${JSON.stringify(pageContext.structure.mainContentSelector)}
- Theme: ${pageContext.theme}
- Headlines (sample): ${pageContext.content.headlines.slice(0,2).map(h => h.text).join('; ')}
- Paragraphs (sample count): ${pageContext.content.paragraphs.length}

Available Tools:
${toolDescriptions}

Instructions for response:
1. Analyze the user command carefully in the context of the web page.
2. Select the most appropriate tool(s) to achieve the user's goal. You can use multiple tools if needed.
3. For each tool, determine the correct parameters based on the command and page context.
   - For CSS or selection, if the user is vague (e.g., "make text bigger"), try to infer reasonable targets (e.g., main paragraph text, or specific elements if context allows).
   - If selecting elements, use specific criteria if possible.
   - If generating CSS, provide a clear description for the AI to work with.
4. Respond with ONLY a valid JSON object following this structure:
{
    "reasoning": "Brief analysis of the command and your approach to fulfill it. Explain your choice of tools and parameters.",
    "actions": [
        {
            "tool": "toolName",
            "parameters": { "param1": "value1", ... },
            "reasoning": "Brief explanation for choosing this specific tool and parameters for this step."
        }
        // Add more actions if needed
    ]
}

Focus on efficiency and directness. If a command is simple, the plan should be simple.
If the command is ambiguous, make a reasonable interpretation or use a general tool.
Example: If user says "dark mode", your 'generateCSS' description should be "apply a dark theme to the page".
Example: If user says "hide ads", 'hideElements' criteria should be "advertisements, sponsored content".
Example: If user says "summarize this article", 'summarizeContent' could be used with no selectors (to use main content) or specific selectors if identifiable.
Example: If user says "make the headings blue and summarize the intro", this would be two actions: one 'generateCSS' for headings, one 'summarizeContent' for intro paragraphs.
Do not invent tools. Only use the tools provided.
If no suitable tool or action can be determined, respond with an empty "actions" array and explain why in the "reasoning".
`;

        try {
            const response = await this.callAI(prompt);
            return this.parseJSONResponse(response);
        } catch (error) {
            console.error("Error in planExecution AI call:", error);
            // Fallback to a structure that indicates failure to plan
            return {
                reasoning: `Failed to generate execution plan due to AI call error: ${error.message}`,
                actions: []
            };
        }
    }

    async executeTool(toolName, parameters) {
        const tool = this.tools.get(toolName);
        if (!tool) {
            console.error(`Unknown tool: ${toolName}`);
            throw new Error(`Unknown tool: ${toolName}`);
        }
        console.log(`Executing tool: ${toolName}`, parameters);
        try {
            const result = await tool.execute(parameters); // This is where tools like generateCSS return { css: "...", ... }
            console.log(`Tool ${toolName} execution result:`, result);
            return result;
        } catch (error) {
            console.error(`Error during ${toolName} execution:`, error);
            throw error; // Re-throw to be caught by Promise.allSettled handler
        }
    }

    async aiSelectElements(criteria, context) {
        const pageContext = await this.getCachedPageContext(); // Use fresh context for selection
        const relevantElementsSample = this.getRelevantElements(criteria)
            .slice(0, 20) // Limit sample size for prompt
            .map(el => `- Selector: ${el.selector}, Text: "${el.text.substring(0, 60).replace(/\s+/g, ' ').trim()}...", Tag: ${el.tag}, Classes: ${el.classes}, ID: ${el.id || 'none'}`);

        const prompt = `
You are an expert DOM element selector. Based on the user's criteria and page context, identify the most relevant CSS selectors.

User Criteria: "${criteria}"
Context for Selection: "${context}"
Page URL: ${pageContext.url}
Page Title: ${pageContext.title}

Sample of Potentially Relevant Elements on Page:
${relevantElementsSample.join('\n') || "No specific elements pre-filtered, consider common tags for the criteria."}

Instructions:
- Analyze the criteria and context.
- Return a JSON object with a "selected" key, which is an array of CSS selectors.
- Prioritize IDs if stable, otherwise robust class or attribute selectors. Avoid overly generic selectors like 'div' or 'p' unless highly qualified.
- If multiple distinct groups of elements match, include selectors for each.
- If no elements seem to match, return an empty array for "selected".
- Provide a brief "reasoning" for your choices.

Respond with ONLY valid JSON:
{
    "selected": ["selector1", ".some-class > li", "#specificId"],
    "reasoning": "Brief explanation of why these selectors were chosen."
}
`;
        try {
            const response = await this.callAI(prompt);
            const result = this.parseJSONResponse(response);
            if (!result || !Array.isArray(result.selected)) {
                 console.warn("aiSelectElements got invalid JSON or missing 'selected' array", result);
                 return [];
            }
            return result.selected; // This should be an array of selectors
        } catch (error) {
            console.error("Error in aiSelectElements:", error);
            return []; // Return empty array on error
        }
    }

    getRelevantElements(criteria) {
        const allElements = this.getAllPageElements();
        if (!criteria) return allElements.slice(0,50); // Return a general sample if no criteria

        const criteriaLower = criteria.toLowerCase();
        let filtered = []; // Start with empty and add to it

        // More targeted filtering
        if (criteriaLower.includes('headline') || criteriaLower.includes('title') || criteriaLower.includes('heading')) {
            filtered = allElements.filter(el =>
                ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(el.tag) ||
                el.classes.toLowerCase().includes('title') || el.classes.toLowerCase().includes('headline') || el.id.toLowerCase().includes('title')
            );
        } else if (criteriaLower.includes('ad') || criteriaLower.includes('advertisement') || criteriaLower.includes('sponsor')) {
            filtered = allElements.filter(el =>
                el.classes.toLowerCase().includes('ad') || el.id.toLowerCase().includes('ad') ||
                el.classes.toLowerCase().includes('advertisement') || el.classes.toLowerCase().includes('sponsor') ||
                el.selector.includes('[class*="adsbygoogle"]') // common ad pattern
            );
        } else if (criteriaLower.includes('navigation') || criteriaLower.includes('menu')) {
             filtered = allElements.filter(el => el.tag === 'nav' || el.id.toLowerCase().includes('menu') || el.classes.toLowerCase().includes('menu') ||  el.classes.toLowerCase().includes('nav'));
        } else if (criteriaLower.includes('sidebar') || criteriaLower.includes('aside')) {
            filtered = allElements.filter(el =>
                el.tag === 'aside' || el.classes.toLowerCase().includes('sidebar') || el.id.toLowerCase().includes('sidebar') ||
                el.classes.toLowerCase().includes('side')
            );
        } else if (criteriaLower.includes('button') || criteriaLower.includes('link')) {
            filtered = allElements.filter(el => el.tag === 'button' || el.tag === 'a' || el.classes.toLowerCase().includes('button') || el.role === 'button' || el.role === 'link');
        } else if (criteriaLower.includes('image') || criteriaLower.includes('picture')) {
            filtered = allElements.filter(el => el.tag === 'img' || el.tag === 'picture');
        } else if (criteriaLower.includes('form') || criteriaLower.includes('input') || criteriaLower.includes('search')) {
            filtered = allElements.filter(el => el.tag === 'form' || el.tag === 'input' || el.classes.toLowerCase().includes('search') || el.id.toLowerCase().includes('search') || el.role === 'search');
        } else {
            // Generic text match as a fallback if no specific keywords hit
            filtered = allElements.filter(el => el.text.toLowerCase().includes(criteriaLower) || el.classes.toLowerCase().includes(criteriaLower) || el.id.toLowerCase().includes(criteriaLower));
        }

        return filtered.length > 0 ? filtered.slice(0, 50) : allElements.slice(0,30); // Return some elements if filter is too aggressive, or a general sample
    }

    async aiModifyText(selectors, transformType, instructions) {
        if (!selectors || selectors.length === 0) {
            return { modifiedCount: 0, message: "No selectors provided for text modification." };
        }

        const modifications = [];
        let modifiedCount = 0;

        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length === 0) {
                    console.warn(`No elements found for selector: ${selector} in aiModifyText`);
                    continue;
                }

                for (const element of elements) {
                    const originalText = element.textContent?.trim();
                    if (!originalText || originalText.length < 10) continue; // Skip empty or very short texts

                    // Avoid re-modifying if already done by this tool type (simple check)
                    if (element.getAttribute('data-ai-modified') === 'true' && element.getAttribute('data-ai-transform-type') === transformType) {
                        continue;
                    }

                    const transformedText = await this.transformText(originalText, transformType, instructions);

                    if (transformedText && transformedText !== originalText) {
                        if (!element.getAttribute('data-original-text')) { // Store original only once
                           element.setAttribute('data-original-text', originalText);
                        }
                        element.textContent = transformedText;
                        element.setAttribute('data-ai-modified', 'true');
                        element.setAttribute('data-ai-transform-type', transformType);

                        modifications.push({
                            selector,
                            originalText,
                            transformedText
                        });
                        modifiedCount++;
                    }
                }
            } catch (e) {
                 console.warn(`Error processing selector ${selector} in aiModifyText:`, e);
            }
        }

        return { modifiedCount, modifications, message: `Modified ${modifiedCount} element(s).` };
    }

    async transformText(text, transformType, instructions) {
        // Basic guard against excessively long text to avoid high costs / long processing
        const MAX_TEXT_LENGTH = 3000; // characters, adjust as needed
        let textToTransform = text;
        if (textToTransform.length > MAX_TEXT_LENGTH) {
            textToTransform = textToTransform.substring(0, MAX_TEXT_LENGTH) + "... (truncated)";
        }

        const prompt = `
Transform the following text.
Original Text: "${textToTransform}"
Transformation Type: ${transformType}
Specific Instructions: ${instructions}

Rules for AI:
- Adhere strictly to the transformation type and instructions.
- If summarizing, be concise. If rephrasing, maintain meaning. If de-clickbaiting, make it factual.
- Return ONLY the transformed text. No explanations, no apologies, no extra phrases like "Here is the transformed text:".
- If the transformation is not possible or doesn't make sense for the given text, return the original text.
`;

        try {
            const response = await this.callAI(prompt);
            // Sometimes the AI might still wrap its response. Try to clean it.
            return response.replace(/^["']|["']$/g, '').trim(); // Remove surrounding quotes
        } catch (error) {
            console.error("Error during AI text transformation:", error);
            throw new Error(`AI transformation failed: ${error.message}`); // Propagate error
        }
    }

    async aiGenerateCSS(description, targetElements = []) {
        let contextInfo = "";
        if (targetElements && targetElements.length > 0) {
            contextInfo = `Specific Target Elements Context:\n${this.getElementStyles(targetElements)}`;
        } else {
            contextInfo = `General Page Style Context:\n${this.getPageStyleContext()}`;
        }

        const prompt = `
You are an expert CSS generator. Generate CSS code based on the user's description and provided context.

User's Desired Style: "${description}"

${contextInfo}
Current Page Theme: ${this.detectCurrentTheme()}

Instructions for CSS Generation:
- Generate clean, modern CSS.
- Use specific selectors if targetElements are provided and seem appropriate. Otherwise, generate reasonably scoped CSS (e.g., for body, main content, headings, paragraphs).
- If the request is about a theme (e.g., "dark mode"), provide comprehensive rules for common elements (body, text, links, backgrounds).
- If the request implies changing layout, use flexbox or grid where appropriate.
- IMPORTANT: Return ONLY the raw CSS code. No explanations, no markdown backticks (like \`\`\`css), no "Here's the CSS:" prefix. Just the CSS.
- If you cannot generate meaningful CSS for the request, return an empty string or a comment like "/* No applicable CSS generated. */".

Example for "make headings blue":
h1, h2, h3 { color: blue; }

Example for "dark mode":
body { background-color: #121212; color: #e0e0e0; }
a { color: #bb86fc; }
/* ... more rules ... */

CSS Code:
`;
        try {
            const css = await this.callAI(prompt);
            // Clean potential markdown backticks if AI still adds them
            return css.replace(/```css/g, '').replace(/```/g, '').trim();
        } catch(error) {
            console.error("Error during AI CSS generation:", error);
            throw new Error(`AI CSS generation failed: ${error.message}`);
        }
    }

    getElementStyles(selectors) {
        if (!Array.isArray(selectors)) return "";
        return selectors.slice(0,5).map(sel => { // Limit to 5 selectors for context brevity
            try {
                const el = document.querySelector(sel);
                if (el) {
                    const styles = window.getComputedStyle(el);
                    return `Selector "${sel}": font-size: ${styles.fontSize}, color: ${styles.color}, background-color: ${styles.backgroundColor}, display: ${styles.display}. HTML: ${el.outerHTML.substring(0,100)}`;
                }
            } catch (e) { console.warn(`Invalid selector "${sel}" in getElementStyles`); }
            return `Selector "${sel}": (not found or error fetching styles)`;
        }).filter(Boolean).join('\n');
    }

    getPageStyleContext() {
        try {
            const body = document.body;
            const styles = window.getComputedStyle(body);
            const mainContentSelector = this.findMainContentSelector() || 'body';
            const mainElement = document.querySelector(mainContentSelector);
            const mainStyles = mainElement ? window.getComputedStyle(mainElement) : styles;

            return `Body: font-family: ${styles.fontFamily}, font-size: ${styles.fontSize}, color: ${styles.color}, background: ${styles.backgroundColor}.
Main Content Area (${mainContentSelector}): background: ${mainStyles.backgroundColor}, color: ${mainStyles.color}.`;
        } catch (e) {
            console.warn("Error in getPageStyleContext:", e);
            return "Could not reliably determine page style context.";
        }
    }

    async aiTransformLayout(transformation, scope) {
        const layoutContext = this.analyzePageLayout();
        let targetSelector = this.findMainContentSelector(); // Default target

        if (scope) {
            try {
                if (scope.match(/^([#.]|\[|\w+)/) && document.querySelector(scope)) {
                    targetSelector = scope;
                } else {
                    transformation = `${transformation} (focus on scope: ${scope})`;
                }
            } catch (e) {
                 console.warn(`Invalid scope selector "${scope}" in aiTransformLayout, using default target.`);
                 transformation = `${transformation} (focus on scope: ${scope})`;
            }
        }

        const prompt = `
Generate CSS for a page layout transformation.
Transformation Goal: "${transformation}"
Target Area/Selector Hint: "${targetSelector}" (If this is 'body', consider broader page structure unless specified otherwise)

Current Layout Context:
- Navigation Present: ${layoutContext.hasNavigation}
- Sidebar Present: ${layoutContext.hasSidebar}
- Footer Present: ${layoutContext.hasFooter}
- Main Content Area Selector: ${layoutContext.mainContentSelector} (This is likely the primary area to affect)
- Page Container Type: ${layoutContext.containerType} (e.g. 'contained' or 'full-width')

Instructions:
- Generate robust CSS to achieve the layout transformation. Use flexbox or grid where appropriate.
- Target the CSS as specifically as possible to the intended area (e.g., using '${targetSelector}' or its children).
- Avoid overly broad selectors like 'div' or '*' unless necessary for the transformation.
- Return ONLY the raw CSS code. No explanations, no markdown, just CSS.
- If the transformation is unclear or cannot be achieved with CSS, return a comment like "/* Layout transformation not applicable or clear. */".

CSS Code:
`;
        try {
            const css = await this.callAI(prompt);
            return css.replace(/```css/g, '').replace(/```/g, '').trim();
        } catch (error) {
            console.error("Error during AI Layout Transformation:", error);
            throw new Error(`AI Layout Transformation failed: ${error.message}`);
        }
    }

    parseJSONResponse(response) {
        let rawResponse = response;
        try {
            const jsonMatchBlock = response.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatchBlock && jsonMatchBlock[1]) {
                rawResponse = jsonMatchBlock[1];
            } else {
                const jsonMatchSimple = response.match(/```\s*([\s\S]*?)\s*```/);
                 if (jsonMatchSimple && jsonMatchSimple[1]) {
                    rawResponse = jsonMatchSimple[1];
                }
            }
            return JSON.parse(rawResponse);
        } catch (error) {
            console.warn('Initial JSON.parse failed. Trying to extract JSON from potentially malformed response:', response.substring(0, 200), error);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch && jsonMatch[0]) {
                try {
                    return JSON.parse(jsonMatch[0]);
                } catch (innerError) {
                    console.error('Failed to parse extracted JSON:', jsonMatch[0].substring(0,200), innerError);
                }
            }
            console.error('Could not parse JSON response after multiple attempts:', response.substring(0,500));
            throw new Error('Invalid JSON response from AI. Original response preview: ' + response.substring(0, 200));
        }
    }

    async getCachedPageContext() {
        const CACHE_DURATION = 15000; // 15 seconds cache for page context
        if (this.pageContext && this.contextCacheTime && (Date.now() - this.contextCacheTime < CACHE_DURATION)) {
            // console.log("Using cached page context");
            return this.pageContext;
        }

        // console.log("Generating fresh page context");
        this.pageContext = await this.getPageContext();
        this.contextCacheTime = Date.now();

        clearTimeout(this.contextCacheTimeout);
        this.contextCacheTimeout = setTimeout(() => {
            this.pageContext = null;
            // console.log("Page context cache expired");
        }, CACHE_DURATION);

        return this.pageContext;
    }

    async getPageContext() { // Make it async if any sub-functions become async
        // console.log("Building page context");
        return {
            url: window.location.href,
            domain: this.getDomainKey(),
            title: document.title,
            content: { // Keep these reasonably small for prompts
                headlines: this.extractHeadlines().slice(0, 5),       // limit samples
                paragraphs: this.extractParagraphs().slice(0, 3),     // limit samples
                links: this.extractLinks().slice(0,5),                // limit samples
                images: this.extractImages().slice(0,3)               // limit samples
            },
            structure: this.analyzePageStructure(),
            theme: this.detectCurrentTheme(),
            existingCustomizations: Array.from(this.appliedStyles).slice(-3) // last 3 applied styles as string keys
        };
    }

    extractHeadlines() {
        const headlines = [];
        document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
            const text = el.textContent?.trim();
            if (text && text.length > 3 && text.length < 200) { // Added max length
                headlines.push({
                    text: text,
                    selector: this.generateSelector(el),
                    tag: el.tagName.toLowerCase()
                });
            }
        });
        return headlines;
    }

    extractParagraphs() {
        const paragraphs = [];
        document.querySelectorAll('p').forEach(el => {
            const text = el.textContent?.trim();
            // Ensure it's not a paragraph with just a link or image, or very short
            if (text && text.length > 20 && text.length < 500 && el.children.length === 0) {
                paragraphs.push({
                    text: text,
                    selector: this.generateSelector(el),
                    wordCount: text.split(/\s+/).length
                });
            }
        });
        return paragraphs;
    }

    extractLinks() {
        const links = [];
        document.querySelectorAll('a[href]').forEach(el => {
            const text = el.textContent?.trim();
            const href = el.getAttribute('href');
            if (text && text.length > 2 && text.length < 100 && href && !href.startsWith('javascript:')) {
                links.push({
                    text: text,
                    href: href, // el.href would give absolute URL, getAttribute gives original
                    selector: this.generateSelector(el)
                });
            }
        });
        return links;
    }

    extractImages() {
        const images = [];
        document.querySelectorAll('img').forEach(el => {
            const src = el.getAttribute('src'); // Use getAttribute to get original src
            if (src && !src.startsWith('data:')) { // Avoid long data URIs
                 images.push({
                    src: src.substring(0,200), // Truncate long src
                    alt: el.alt?.substring(0,100) || '',
                    selector: this.generateSelector(el)
                });
            }
        });
        return images;
    }

    getAllPageElements() {
        const elements = [];
        const selectors = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div[class]', 'section[class]', 'article[class]', 'aside[class]', 'nav[class]', 'li', 'a[href]', 'button'];
        const seenSelectors = new Set();

        selectors.forEach(tagSelector => {
            try {
                document.querySelectorAll(tagSelector).forEach(el => {
                    // Filter out invisible or very small elements
                    if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) {
                        return;
                    }

                    const currentSelector = this.generateSelector(el);
                    if (seenSelectors.has(currentSelector)) return; // Avoid duplicates from overlapping initial selectors
                    seenSelectors.add(currentSelector);

                    const text = el.textContent?.trim() || '';
                    if (text.length > 2 || ['nav','aside','section','article','button','a'].includes(el.tagName.toLowerCase())) {
                        elements.push({
                            selector: currentSelector,
                            tag: el.tagName.toLowerCase(),
                            text: text.substring(0, 80).replace(/\s+/g, ' ').trim(),
                            classes: Array.from(el.classList).join(' '),
                            id: el.id || '',
                            role: el.getAttribute('role') || ''
                        });
                    }
                });
            } catch (e) {
                // Catch errors from potentially invalid selectors formed by tagSelector (though unlikely for these simple ones)
                console.warn(`Error querying elements for selector "${tagSelector}" in getAllPageElements:`, e);
            }
        });
        return elements.slice(0, 150); // Limit total elements sent to AI for performance.
    }

    analyzePageStructure() {
        return {
            hasNavigation: !!document.querySelector('nav, [role="navigation"], .navigation, header nav, #nav, #menu, .menu'),
            hasSidebar: !!document.querySelector('.sidebar, aside, .side-bar, #sidebar'),
            hasFooter: !!document.querySelector('footer, .footer, #footer'),
            hasComments: !!document.querySelector('.comments, #comments, .comment-list'),
            mainContentSelector: this.findMainContentSelector(),
            adElementCount: this.findAdElements().length,
            formCount: document.querySelectorAll('form').length
        };
    }

    analyzePageLayout() {
        return {
            hasNavigation: !!document.querySelector('nav, header nav, [role="navigation"]'),
            hasSidebar: !!document.querySelector('.sidebar, aside'),
            hasFooter: !!document.querySelector('footer'),
            mainContentSelector: this.findMainContentSelector(),
            containerType: this.detectContainerType()
        };
    }

    findMainContentSelector() {
        const candidates = [
            'main', '[role="main"]', 'article.post', 'div.post', 'div.entry', '.main-content', '.main_content',
            '#main-content', '#main_content', '#content', '.content', '#page-content',
            'article[class*="content"]', 'section[class*="content"]',
            'div[class*="main"]:not([class*="nav"]):not([class*="header"]):not([class*="footer"])', // Be more specific
            'div[class*="container"] article', 'div.container > .row > .col' // Common bootstrap patterns
        ];

        for (const selector of candidates) {
            try {
                const element = document.querySelector(selector);
                // Basic visibility and size check to prefer prominent main content areas
                if (element && element.offsetHeight > 200 && element.offsetWidth > 200 && window.getComputedStyle(element).display !== 'none') {
                    return selector;
                }
            } catch (e) { /* querySelector can fail with very complex/invalid selectors, though unlikely here */ }
        }
        // Fallback if no prominent one is found with size checks
        for (const selector of candidates) {
             try { if (document.querySelector(selector)) return selector; } catch (e) {}
        }
        return 'body'; // Ultimate fallback
    }

    findAdElements() {
        const adSelectors = [
            '[class*="ad"]:not([class*="add"]):not([class*="pad"]):not([class*="head"])',
            '[id*="ad"]:not([id*="add"]):not([id*="pad"]):not([id*="head"])',
            '[class*="advert"]', '[id*="advert"]',
            '[class*="sponsor"]', '[id*="sponsor"]',
            'iframe[src*="ads"]', 'div[data-ad-unit]', 'ins.adsbygoogle',
            'div[aria-label*="advertisement"]', 'div[id*="google_ads_iframe"]'
        ];

        const ads = new Set(); // Use a Set to store unique selectors
        adSelectors.forEach(selector => {
            try {
                document.querySelectorAll(selector).forEach(el => {
                    if (el.offsetHeight > 10 && el.offsetWidth > 10 && window.getComputedStyle(el).display !== 'none') { // Basic visibility check
                        ads.add(this.generateSelector(el));
                    }
                });
            } catch (e) { console.warn(`Invalid ad selector: ${selector}`); }
        });
        return Array.from(ads);
    }

    detectContainerType() {
        try {
            const bodyStyle = window.getComputedStyle(document.body);
            const bodyWidth = document.body.clientWidth;

            const commonWrappers = ['.container', '.wrapper', '.page-wrapper', '#container', '#wrapper', '#page', '.main-container'];
            for (const sel of commonWrappers) {
                const el = document.querySelector(sel);
                if (el) {
                    const elWidth = el.clientWidth;
                    if (elWidth < bodyWidth * 0.95 && elWidth > 300) { // Significantly narrower than body
                        return `contained (approx ${elWidth}px wide in a ${bodyWidth}px body)`;
                    }
                }
            }
            if (parseInt(bodyStyle.marginLeft) > 20 || parseInt(bodyStyle.marginRight) > 20) {
                 return 'full-width with body margins';
            }
            return 'likely full-width';
        } catch (e) { return 'unknown'; }
    }

    detectCurrentTheme() {
        const body = document.body;
        if (body.classList.contains('dark') || body.classList.contains('dark-mode') || body.getAttribute('data-theme') === 'dark') {
            return 'dark';
        }

        try {
            const bodyStyle = window.getComputedStyle(body);
            const bgColor = bodyStyle.backgroundColor;
            const color = bodyStyle.color;

            const isDark = (c) => {
                if (!c || c === "transparent" || c === "rgba(0, 0, 0, 0)") return null; // Can't determine from transparent
                const rgbMatch = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                if (rgbMatch) {
                    const r = parseInt(rgbMatch[1]);
                    const g = parseInt(rgbMatch[2]);
                    const b = parseInt(rgbMatch[3]);
                    // Luminance formula
                    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
                }
                return null; // Can't parse
            };

            const bgIsDark = isDark(bgColor);
            const textIsLight = isDark(color) === false; // Explicitly check for light text

            if (bgIsDark === true && textIsLight === true) return 'dark';
            if (bgIsDark === false && textIsLight === false) return 'light'; // Dark text on light bg

            // If one is determinate and the other isn't, make a guess
            if (bgIsDark === true) return 'likely dark background';
            if (textIsLight === true) return 'likely light text on unspecified background';

        } catch (e) { /* ignore errors from getComputedStyle in edge cases */ }

        return 'unknown (defaulting to light assumption)'; // Default assumption
    }

    generateSelector(element) {
        if (!element || !(element instanceof Element)) return 'unknown_element';

        if (element.id) {
            const escapedId = CSS.escape(element.id);
            // Ensure ID is reasonably unique and valid
            if (!/^\d/.test(element.id) && document.querySelectorAll(`#${escapedId}`).length === 1) {
                 return `#${escapedId}`;
            }
        }

        let path = '';
        let currentElement = element;
        const MAX_SELECTOR_DEPTH = 4; // Limit selector complexity
        let depth = 0;

        while (currentElement && currentElement.tagName !== 'BODY' && currentElement.tagName !== 'HTML' && depth < MAX_SELECTOR_DEPTH) {
            let segment = currentElement.tagName.toLowerCase();
            const classes = Array.from(currentElement.classList)
                                .filter(cls => cls && !/^\d/.test(cls) && !cls.includes(':') && !cls.includes('(') && cls.length < 50) // Filter problematic/long classes
                                .slice(0, 2); // Max 2 classes

            if (classes.length > 0) {
                segment += '.' + classes.map(cls => CSS.escape(cls)).join('.');
            } else {
                const parent = currentElement.parentNode;
                if (parent && parent instanceof Element) { // Ensure parent is an Element
                    const siblings = Array.from(parent.children)
                                       .filter(el => el.tagName === currentElement.tagName);
                    if (siblings.length > 1) {
                        const index = siblings.indexOf(currentElement);
                        if (index !== -1) { // Check if indexOf found the element
                           segment += `:nth-of-type(${index + 1})`;
                        }
                    }
                }
            }
            path = segment + (path ? ' > ' + path : '');

            try { // Validate selector at each step if possible
                if (document.querySelectorAll(path).length === 1 && path.length > 5) { // Prefer unique, somewhat specific
                    return path;
                }
            } catch(e) { /* Path might be temporarily invalid/complex during construction, or too slow */ break; }

            currentElement = currentElement.parentNode;
            depth++;
        }
        if (!path && element.tagName) return element.tagName.toLowerCase(); // Last resort for top-level elements or if loop fails
        return path || element.tagName.toLowerCase(); // Fallback to tag if path is empty
    }

    getDomainKey() {
        try {
            const hostname = window.location.hostname;
            const parts = hostname.split('.');
            if (parts.length > 2) {
                // Check for common second-level domains like .co.uk, .com.au
                if (parts.length > 3 && (parts[parts.length-2].match(/^(co|com|org|gov|net|ac|edu)$/i) && parts[parts.length-1].length === 2)) {
                    return parts.slice(-3).join('.');
                }
                return parts.slice(-2).join('.');
            }
            return hostname;
        } catch (e) {
            console.warn("Error getting domain key:", e);
            return 'unknown.domain';
        }
    }

    applyCustomCSS(css, description) {
        const cleanCSS = this.sanitizeCSS(css);
        // Use description as the key for `appliedStyles` to prevent duplicate rule applications *within a session*
        const styleKey = description || `css-${Date.now()%10000}`;

        if (cleanCSS.trim()) {
            // Check if this styleKey's CSS has already been applied in this session.
            // This is a simple check based on the description/styleKey.
            if (this.appliedStyles.has(styleKey)) {
                // Allow re-application for rules that are often re-evaluated or might change,
                // like those from 'generateCSS', 'transformLayout', or 'hideElements'
                // if they are being re-run in the same session before caching kicks in or if caching strategy changes.
                // For a direct 'applyCSS' call from a cached rule, if the description is identical,
                // we might infer it's already there.
                const isPotentiallyDynamic = description.startsWith("Generated CSS:") || description.startsWith("Layout:") || description.startsWith("Hide:");
                if (!isPotentiallyDynamic) {
                    // console.log(`CSS for "${styleKey}" (static) already noted as applied in this session. Returning status.`);
                    return {
                        appliedInThisCall: false,
                        alreadyAppliedSession: true, // Indicates it was already applied in the current page session
                        description: description,
                        message: "CSS with this description was already applied in this session."
                    };
                }
            }

            const cssWithComment = `\n/* AI Customization: ${description} */\n${cleanCSS}\n`;
            this.styleElement.textContent += cssWithComment;
            this.appliedStyles.add(styleKey); // Track that this description's CSS has been applied in this session
            // console.log(`Applied CSS for: ${description}`);
            return {
                appliedInThisCall: true,
                alreadyAppliedSession: false,
                description: description,
                finalCSS: cleanCSS
            };
        } else {
            // console.log(`No CSS to apply for: ${description} (CSS was empty or sanitized away)`);
            return {
                appliedInThisCall: false,
                alreadyAppliedSession: false,
                description: description,
                message: "No CSS to apply (empty or sanitized)."
            };
        }
    }

    sanitizeCSS(css) {
        if (!css || typeof css !== 'string') return '';
        let sanitized = css;
        sanitized = sanitized.replace(/<style[\s\S]*?<\/style>/gi, '');
        sanitized = sanitized.replace(/<script[\s\S]*?<\/script>/gi, '');
        sanitized = sanitized.replace(/javascript:/gi, '/*javascript:*/');
        sanitized = sanitized.replace(/expression\s*\(/gi, '/*expression(*/');
        sanitized = sanitized.replace(/url\s*\(\s*['"]?\s*javascript:/gi, 'url(/*javascript:*/');
        sanitized = sanitized.replace(/@import/gi, '/*@import*/');
        // Consider more aggressive sanitization if security is paramount and AI output is less trusted
        return sanitized.trim();
    }

    async callAI(prompt) {
        if (!this.aiConfig.apiKey) {
            console.error('AI API key not configured');
            throw new Error('AI API key not configured. Please set it in the extension options.');
        }

        const fullUrl = `${this.aiConfig.endpoint}/${this.aiConfig.model}:generateContent?key=${this.aiConfig.apiKey}`;
        // console.log(`Calling AI: ${this.aiConfig.model} for prompt starting with: "${prompt.substring(0,100)}..."`);

        try {
            const response = await fetch(fullUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 2000, // Increased slightly for potentially larger CSS/JSON plans
                        topP: 0.95, // Standard value
                        topK: 40    // Standard value
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "Could not read error text from API response.");
                console.error('Gemini API Error:', response.status, errorText.substring(0,500));
                throw new Error(`Gemini API request failed: ${response.status}. Details: ${errorText.substring(0,300)}`);
            }

            const data = await response.json();
            // console.log("AI Response Data (preview):", JSON.stringify(data, null, 2).substring(0, 500));

            if (data.promptFeedback && data.promptFeedback.blockReason) {
                console.error('Gemini API blocked prompt:', data.promptFeedback.blockReason, data.promptFeedback.safetyRatings);
                throw new Error(`Gemini API blocked the prompt. Reason: ${data.promptFeedback.blockReason}`);
            }
            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0] || !data.candidates[0].content.parts[0].text) {
                console.error('Invalid response structure from Gemini API:', data);
                throw new Error('Invalid or empty response structure from Gemini API.');
            }

            const textResponse = data.candidates[0].content.parts[0].text.trim();
            // console.log(`AI Raw Text Response (preview): "${textResponse.substring(0,200)}..."`);
            return textResponse;

        } catch (error) {
            console.error('Error during callAI fetch operation:', error);
            if (error.message.startsWith('AI API key not configured')) throw error; // Preserve specific error
            throw new Error(`AI communication failed: ${error.message}`);
        }
    }

    initializeContentObserver() {
        if (this.contentObserver) this.contentObserver.disconnect();

        this.contentObserver = new MutationObserver((mutations) => {
            let hasSignificantChange = false;
            if (!this.isInitialized) return;

            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const tagName = node.tagName.toUpperCase();
                            const classList = node.classList;
                            if (tagName === 'ARTICLE' || tagName === 'SECTION' || tagName === 'MAIN' ||
                                classList.contains('content') || classList.contains('post') ||
                                classList.contains('comments') || node.id === 'comments' ||
                                (node.children && node.querySelector('article, section, .post, #comments'))) { // Check children too
                                hasSignificantChange = true;
                                break;
                            }
                        }
                    }
                }
                 if (hasSignificantChange) break;
            }

            if (hasSignificantChange) {
                console.log('Significant DOM change detected. Debouncing reapplication of rules.');
                clearTimeout(this.reapplyTimeout);
                this.reapplyTimeout = setTimeout(() => {
                    if (this.domainRules.has(this.getDomainKey())) {
                        console.log('Reapplying domain rules due to DOM change.');
                        this.reapplyDomainRules();
                    }
                }, 2500);
            }
        });

        this.contentObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    async loadDomainRules() {
        try {
            if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
                const result = await browser.storage.local.get('domainRules');
                console.log('[LoadRules] Raw result from browser.storage.local.get(\'domainRules\'):', result ? JSON.stringify(result).substring(0,500) + '...' : 'undefined/null');
                const loadedRulesObject = result.domainRules || {};
                this.domainRules = new Map(Object.entries(loadedRulesObject));
                console.log(`[LoadRules] Loaded this.domainRules. Size: ${this.domainRules.size}. Keys:`, Array.from(this.domainRules.keys()).join(', '));
                if (this.domainRules.size > 0) {
                    // console.log('[LoadRules] Content of loaded domainRules (preview first entry if exists):', JSON.stringify(Object.fromEntries(this.domainRules), null, 2).substring(0, 500) + "...");
                }
            } else {
                console.warn("[LoadRules] Browser storage API not available. Cannot load domain rules.");
                this.domainRules = new Map();
            }
        } catch (error) {
            console.error('Failed to load domain rules:', error);
            this.domainRules = new Map();
        }
    }

    async saveDomainRule(ruleData) {
        const domain = this.getDomainKey();
        if (!this.domainRules.has(domain)) {
            this.domainRules.set(domain, []);
        }

        const domainRulesList = this.domainRules.get(domain);
        domainRulesList.push(ruleData);

        const MAX_RULES_PER_DOMAIN = 10; // Increased slightly
        if (domainRulesList.length > MAX_RULES_PER_DOMAIN) {
            domainRulesList.sort((a,b) => b.timestamp - a.timestamp); // Keep most recent
            domainRulesList.splice(MAX_RULES_PER_DOMAIN);
        }

        try {
            if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
                const domainRulesObj = Object.fromEntries(this.domainRules);
                await browser.storage.local.set({ domainRules: domainRulesObj });
                // console.log(`Domain rule saved for ${domain}: "${ruleData.command}"`);
            } else {
                console.warn("Browser storage API not available. Cannot save domain rule.");
            }
        } catch (error) {
            console.error('Failed to save domain rule:', error);
        }
    }

    async applyExistingRules() {
        const domain = this.getDomainKey();
        const rulesForDomain = this.domainRules.get(domain) || [];

        console.log(`[ApplyRules] Checking rules for domain '${domain}'. Found ${rulesForDomain.length} rules before filtering.`);

        if (rulesForDomain.length === 0) {
            console.log("[ApplyRules] No existing rules to apply for this domain (pre-filter):", domain);
            return;
        }

        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const recentAndEffectiveRules = rulesForDomain.filter(rule =>
            rule.timestamp > thirtyDaysAgo &&
            rule.executionPlan && rule.executionPlan.actions && rule.executionPlan.actions.length > 0 &&
            (rule.results ? rule.results.some(r => r.success) : true)
        );

        console.log(`[ApplyRules] Found ${recentAndEffectiveRules.length} recent/effective rules for domain '${domain}' after filtering.`);

        if (recentAndEffectiveRules.length === 0) {
            console.log("[ApplyRules] No recent or effective rules to reapply for domain (post-filter):", domain);
            return;
        }

        console.log(`Applying ${recentAndEffectiveRules.length} recent/effective rule(s) for domain ${domain}.`);

        const allActionsPromises = [];
        for (const rule of recentAndEffectiveRules) {
            console.log(`Processing rule from command: "${rule.command}" (Plan has ${rule.executionPlan.actions.length} actions)`);
            for (const action of rule.executionPlan.actions) {
                console.log(`[Cache Apply] Executing stored action: Tool='${action.tool}', Params (preview): ${(JSON.stringify(action.parameters) || "").substring(0,100)}...`);
                allActionsPromises.push(
                    this.executeTool(action.tool, action.parameters)
                        .catch(error => {
                            console.error(`Failed to reapply action ${action.tool} from rule "${rule.command}":`, error.message);
                            return null;
                        })
                );
            }
        }

        if (allActionsPromises.length > 0) {
            // console.log(`Reapplying ${allActionsPromises.length} actions in parallel.`);
            const outcomes = await Promise.allSettled(allActionsPromises);
            outcomes.forEach((outcome, index) => {
                if (outcome.status === 'rejected') {
                    // console.warn(`A reapplied action failed (see earlier log for tool and rule command):`, outcome.reason);
                }
            });
            console.log('Finished reapplying domain rules.');
        } else {
            // console.log('No actions to reapply from existing rules.');
        }
    }

    async reapplyDomainRules() {
        console.log("ReapplyDomainRules triggered.");
        this.pageContext = null;
        clearTimeout(this.contextCacheTimeout);
        this.contextCacheTime = 0;

        // `this.appliedStyles` is a Set of descriptions/keys for CSS applied *in the current session*.
        // We don't clear it here because applyExistingRules (and applyCustomCSS) will use it
        // to avoid re-injecting identical CSS blocks if a rule's `applyCSS` action has the same description.
        // This assumes descriptions are somewhat unique or at least consistent for a given CSS block.
        // A more robust system might tag CSS blocks with unique rule IDs if full reset-before-reapply is needed.
        await this.applyExistingRules();
    }

    async resetAll() {
        console.log('Resetting all customizations for domain:', this.getDomainKey());
        if (this.styleElement) {
            this.styleElement.textContent = '';
        }
        this.appliedStyles.clear(); // Clear session-applied styles

        document.querySelectorAll('[data-ai-modified="true"]').forEach(el => {
            const originalText = el.getAttribute('data-original-text');
            if (originalText) {
                el.textContent = originalText;
            }
            el.removeAttribute('data-ai-modified');
            el.removeAttribute('data-original-text');
            el.removeAttribute('data-ai-transform-type');
        });

        const domain = this.getDomainKey();
        if (this.domainRules.has(domain)) {
            this.domainRules.delete(domain);
            try {
                if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
                    const domainRulesObj = Object.fromEntries(this.domainRules);
                    await browser.storage.local.set({ domainRules: domainRulesObj });
                    console.log('Domain rules cleared from storage for:', domain);
                }
            } catch (error) {
                console.error('Failed to clear domain rules from storage:', error);
            }
        }

        this.pageContext = null;
        clearTimeout(this.contextCacheTimeout);
        this.contextCacheTime = 0;
        console.log('Customizations and domain rules reset.');
        // location.reload(); // Uncomment if a full reload is desired after reset
    }
}

// Initialize only when DOM is ready
if (typeof window !== 'undefined') { // Ensure it runs only in a browser context
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            // Ensure only one instance
            if (!window.aiWebCustomizationAgentInstance) {
                window.aiWebCustomizationAgentInstance = new AIWebCustomizationAgent();
            }
        });
    } else {
        if (!window.aiWebCustomizationAgentInstance) {
            window.aiWebCustomizationAgentInstance = new AIWebCustomizationAgent();
        }
    }
}
