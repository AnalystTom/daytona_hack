// Prompts also ask for the JSON and replies are read tolerantly, so a model that ignores response_format still parses.
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export const OPENAI_URL = "https://api.openai.com/v1";

export const withJsonSchema = (instructions: string, schema: object) =>
  `${instructions}\n\nReply with only one JSON object matching this JSON Schema, with no prose or code fences:\n${JSON.stringify(schema)}`;

export const parseJsonReply = (text: string): unknown =>
  JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
