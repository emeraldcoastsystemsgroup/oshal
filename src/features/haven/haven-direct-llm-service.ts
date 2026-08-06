/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Direct OpenAI Chat Completions for Haven using OAuth material from the Cline runtime.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added a direct Gemini REST compatibility path.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: retire both direct-model bypasses and all Cline/env credential reads; compatibility exports now fail closed pending an accounted hosted/BYO rail.
 */

/**
 * @description Shape of a swarm dispatch request retained for source compatibility with historical
 * Haven integrations. No direct-model compatibility function may produce one.
 */
export interface DispatchRequest {
  title: string;
  description: string;
  priority?: 'low' | 'medium' | 'high';
}

/** @description Historical Haven direct-call result shape. */
export interface HavenLlmResult {
  text: string;
  dispatch?: DispatchRequest;
}

/** Build the stable refusal shared by every retired direct-model entry point. */
function directModelCallDisabled(): Error {
  const error = new Error(
    'Haven direct model calls are disabled; use the accounted hosted/BYO provider runtime.',
  );
  (error as Error & { code?: string }).code = 'UNBROKERED_DIRECT_MODEL_CALL';
  return error;
}

/**
 * @description Retired Gemini compatibility entry point. It never reads an environment API key,
 * constructs a credential-bearing URL, or performs network I/O.
 */
export async function havenGoogleChat(
  _systemPrompt: string,
  _messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<HavenLlmResult> {
  throw directModelCallDisabled();
}

/**
 * @description Retired OpenAI/Codex compatibility entry point. It never reads Cline files,
 * environment credentials, or performs network I/O.
 */
export async function havenLlmChat(
  _systemPrompt: string,
  _messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  _enableDispatch: boolean,
): Promise<HavenLlmResult> {
  throw directModelCallDisabled();
}
