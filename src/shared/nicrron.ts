// Nicrron is an OpenAI-compatible gateway; not every model behind it enforces response_format,
// so prompts also ask for the JSON and replies are read tolerantly.
export const DEFAULT_NICRRON_MODEL = "nicrron/auto";
export const DEFAULT_NICRRON_URL = "https://api.nicrron.ai/v1";

export const withJsonSchema = (instructions: string, schema: object) =>
  `${instructions}\n\nReply with only one JSON object matching this JSON Schema, with no prose or code fences:\n${JSON.stringify(schema)}`;

export const parseJsonReply = (text: string): unknown =>
  JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
