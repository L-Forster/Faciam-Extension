class PopupController {
    constructor() {
        this.initializeElements();
        this.loadSavedData();
        this.attachEventListeners();
    }
    
    async initializeElements() {
        this.userInput = document.getElementById('userInput');
        this.globalPromptInput = document.getElementById('globalPrompt');
        this.applyBtn = document.getElementById('applyBtn');
        this.resetBtn = document.getElementById('resetBtn');
        this.status = document.getElementById('status');
        this.apiKeyInput = document.getElementById('apiKey');
        this.apiConfigLabel = document.querySelector('.api-config label');
    }
    
    async loadSavedData() {
        try {
            // Determine current tab for per-tab storage key
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const currentTab = tabs[0];
            const dynamicKey = `lastInput_${currentTab.id}`;

            const result = await browser.storage.local.get(['apiKey', 'globalPromptText', dynamicKey]);
            if (result.apiKey) {
                this.apiKeyInput.value = result.apiKey;
            }
            if (result[dynamicKey]) {
                this.userInput.value = result[dynamicKey];
            }
            if (result.globalPromptText) {
                this.globalPromptInput.value = result.globalPromptText;
            }
        } catch (error) {
            console.error('Popup: Failed to load saved data:', error);
        }
    }
    
    attachEventListeners() {
        this.applyBtn.addEventListener('click', () => this.handleApply());
        this.resetBtn.addEventListener('click', () => this.handleReset());
        
        this.userInput.addEventListener('input', async () => {
            try {
                const tabs = await browser.tabs.query({ active: true, currentWindow: true });
                const dynamicKey = `lastInput_${tabs[0].id}`;
                await browser.storage.local.set({ [dynamicKey]: this.userInput.value });
            } catch (e) {
                console.error('Popup: Failed to save per-tab prompt:', e);
            }
        });

        this.globalPromptInput.addEventListener('input', async () => {
            const globalPromptText = this.globalPromptInput.value.trim();
            try {
                await browser.storage.local.set({ globalPromptText });
                console.log('Global prompt saved.');
            } catch (error) {
                console.error('Popup: Failed to save global prompt:', error);
            }
        });
    }
    
    async handleApply() {
        const localPrompt = this.userInput.value.trim();
        const globalPrompt = this.globalPromptInput.value.trim();
        const apiKey = this.apiKeyInput.value.trim();
        
        if (!apiKey) {
            this.showStatus('Please enter your Gemini API key', 'error');
            return;
        }
        
        if (!localPrompt && !globalPrompt) {
            this.showStatus('Please enter a local or global customization prompt', 'error');
            return;
        }
        
        try {
            this.showStatus('Processing your request...', 'loading');
            this.applyBtn.disabled = true;
            
            // Determine current tab for per-tab storage key
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const currentTab = tabs[0];
            const dynamicKey = `lastInput_${currentTab.id}`;

            await browser.storage.local.set({ apiKey, [dynamicKey]: localPrompt, globalPromptText: globalPrompt });
            
            const response = await browser.runtime.sendMessage({
                action: 'processCustomization',
                userInput: localPrompt,
                apiKey: apiKey,
                tabId: currentTab.id
            });
            
            if (response && typeof response === 'object' && response.success) {
                this.showStatus(response.explanation || '✨ Changes applied successfully!', 'success');
            } else if (response === true) {
                this.showStatus('✨ Changes applied! (Status: OK)', 'success');
                console.warn('Popup.js: Background script responded with boolean TRUE, interpreted as success.', response);
            } else {
                let errorMessage = 'Unknown error from background'; // Default error
                if (typeof response === 'object' && response.error) {
                    errorMessage = response.error;
                } else if (response && typeof response !== 'object') {
                    errorMessage = `Received unexpected data type from background: ${String(response)}`;
                } else if (response && typeof response === 'object' && !response.success) {
                    errorMessage = response.error || 'Operation failed or success status missing in response.';
                }
                
                console.error('Error or unexpected response from background script. Raw response:', response);
                this.showStatus(`Error: ${errorMessage}`, 'error');
            }
        } catch (error) {
            console.error('Popup apply error:', error);
            this.showStatus('Failed to apply changes: ' + (error.message || error), 'error');
        } finally {
            this.applyBtn.disabled = false;
        }
    }
    
    async handleReset() {
        try {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const currentTab = tabs[0];
            
            try {
                await browser.tabs.sendMessage(currentTab.id, { action: 'ping' });
            } catch (e) {
                console.log('Ping failed during reset, injecting scripts into tab:', currentTab.id);
                await browser.tabs.executeScript(currentTab.id, { file: 'browser-polyfill.js' });
                await browser.tabs.executeScript(currentTab.id, { file: 'content.js' });
                await browser.tabs.insertCSS(currentTab.id, { file: 'content.css' });
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            await browser.tabs.sendMessage(currentTab.id, {
                action: 'resetCustomizations'
            });
            
            this.showStatus('Page reset to original state', 'success');
        } catch (error) {
            console.error('Reset error:', error);
            this.showStatus('Failed to reset page: ' + (error.message || error), 'error');
        }
    }
    
    showStatus(message, type) {
        this.status.textContent = message;
        this.status.className = `status ${type}`;
        this.status.style.display = 'block';
        
        if (type === 'loading') {
            this.status.innerHTML = `<span class="spinner"></span>${message}`;
        }
        
        if (type !== 'loading') {
            setTimeout(() => {
                this.status.style.display = 'none';
            }, 3000);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new PopupController();
});