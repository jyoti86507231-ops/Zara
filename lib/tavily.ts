/**
 * Tavily Search API Utility
 * Connects to the Tavily search endpoint to fetch real-time web results.
 */

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilyResponse {
  results?: TavilySearchResult[];
  answer?: string;
  error?: string;
}

export async function searchTavily(query: string, apiKey?: string): Promise<TavilyResponse> {
  const finalApiKey = apiKey || process.env.TAVILY_API_KEY || "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";
  
  if (!finalApiKey) {
    return { error: "Tavily API key is not configured." };
  }

  try {
    console.log(`[Tavily] Executing real-time search for: "${query}"`);
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: finalApiKey,
        query: query,
        search_depth: "basic",
        include_answer: false,
        max_results: 5,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[Tavily] API Error Response:", response.status, errText);
      return { error: `Tavily API returned status ${response.status}: ${errText}` };
    }

    const data = await response.json();
    return data as TavilyResponse;
  } catch (error: any) {
    console.error("[Tavily] Request exception:", error);
    return { error: error.message || String(error) };
  }
}
