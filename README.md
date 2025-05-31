# Faciam Extension - An Open Source client-side code personalization tool 


Defines a suite of agnetic tools to dynamically edit the client-side content of webpages based on user preferences.

## List of available tools:

* **applyCSS**

  * Description: Inject custom CSS to modify page styling.
  * Parameters:

    * `css` (string): CSS code to apply
    * `description` (string): brief note on the rule’s purpose

* **modifyText**

  * Description: Use AI to transform text in specified elements (for example summarize, de-clickbait, simplify)
  * Parameters:

    * `selectors` (array of strings): CSS selectors targeting elements to change
    * `transformType` (string): type of transformation (for example “summarize” or “rephrase”)
    * `instructions` (string): guidance on how the AI should perform the transformation

* **selectElements**

  * Description: Choose DOM elements based on natural-language criteria (often used by other tools)
  * Parameters:

    * `criteria` (string): description of what to select (for example “all headings” or “advertisements”)
    * `context` (string): extra context to help the AI decide which elements fit the criteria

* **generateCSS**

  * Description: Produce CSS from a natural-language request (applied immediately and can be cached)
  * Parameters:

    * `description` (string): plain-language request for styling changes (for example “make headings blue”)
    * `targetElements` (array of strings, optional): CSS selectors to give AI context on which elements to target

* **hideElements**

  * Description: Generate and apply CSS to hide elements matching AI-determined criteria or provided selectors (rules can be cached)
  * Parameters:

    * `criteria` (string): description of what to hide (for example “sponsored content”)
    * *(Alternatively, callers may supply `selectors` as an array)*

* **transformLayout**

  * Description: Generate CSS to alter page layout (for example move sidebar below main content; output can be cached)
  * Parameters:

    * `transformation` (string): description of the layout change (for example “move sidebar below main content”)
    * `scope` (string): optional CSS selector or area to focus on (for example “main article”)

* **summarizeContent**

  * Description: Summarize the main content of the page or specific elements (runs dynamically on load)
  * Parameters:

    * `selectors` (array of strings, optional): CSS selectors identifying parts of the page to summarize (defaults to main content if omitted)
    * `length` (string): detail level (“short”, “medium” or “detailed”)




## License

This project is open source under the AGPLv3.  
A commercial license is available for organizations that cannot comply with AGPLv3’s requirement to release modified source. See [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) or contact louisforster64@gmail.com.
