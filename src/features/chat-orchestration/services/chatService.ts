/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of chatService for posting chat messages to backend API
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed route (/api/message → /api/send-message) and request body to match backend API
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Multi-tenant safety: mint taskId with crypto.randomUUID() (was task-${Date.now()}, which collides if two users send in the same millisecond). Legacy helper; live chat path uses a per-session UUID already.
 */

import axios from "axios";

/**
 * @description Posts a chat message to the backend API endpoint for chat.
 * Handles provider selection and authentication token if required.
 *
 * @param {string} message - The chat message to send.
 * @param {string} providerId - The selected provider's ID.
 * @param {string} [authToken] - Optional authentication token for the provider.
 * @returns {Promise<any>} The API response data.
 * @throws Will throw if the API call fails.
 */
export async function postChatMessage(
  message: string,
  providerId: string,
  authToken?: string
): Promise<any> {
  try {
    // Generate a globally-unique task ID for this conversation. crypto.randomUUID()
    // avoids the cross-user collision a millisecond-based id has under concurrent
    // load. (The live chat UI supplies its own per-session UUID via chat-app.ts;
    // this helper is legacy.)
    const taskId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `task-${crypto.randomUUID()}`
        : `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    
    const response = await axios.post(
      "/api/send-message",
      {
        taskId,
        text: message,
        agenticMode: true,
        source: "chat-ui",
      },
      {
        headers: authToken
          ? {
              Authorization: `Bearer ${authToken}`,
              "Content-Type": "application/json",
            }
          : { "Content-Type": "application/json" },
      }
    );
    return response.data;
  } catch (error) {
    // Optionally log error here or rethrow for UI to handle
    throw error;
  }
}
